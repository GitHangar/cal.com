import { getFormSchema } from "@pages/settings/admin/orgMigrations/moveTeamToOrg";
import { getSession } from "next-auth/react";
import type { NextApiRequest, NextApiResponse } from "next/types";

import { getOrgFullOrigin } from "@calcom/features/ee/organizations/lib/orgDomains";
import { HttpError } from "@calcom/lib/http-error";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import { getTranslation } from "@calcom/lib/server";
import prisma from "@calcom/prisma";
import { RedirectType } from "@calcom/prisma/client";
import { UserPermissionRole } from "@calcom/prisma/enums";
import { teamMetadataSchema } from "@calcom/prisma/zod-utils";

import { migrateUserToOrg } from "../../../lib/orgMigration";

const log = logger.getSubLogger({ prefix: ["moveTeamToOrg"] });

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const rawBody = req.body;

  log.debug(
    "Moving team to org:",
    safeStringify({
      body: rawBody,
    })
  );

  const translate = await getTranslation("en", "common");
  const moveTeamToOrgSchema = getFormSchema(translate);

  const parsedBody = moveTeamToOrgSchema.safeParse(rawBody);

  // Don't know why but if I let it go to getSession, it doesn't return the session.  🤯
  req.body = null;

  const session = await getSession({ req });

  if (!session) {
    return res.status(403).json({ message: "No session found" });
  }

  const isAdmin = session.user.role === UserPermissionRole.ADMIN;

  if (!parsedBody.success) {
    log.error("moveTeamToOrg failed:", safeStringify(parsedBody.error));
    return res.status(400).json({ message: JSON.stringify(parsedBody.error) });
  }

  const { teamId, targetOrgId, moveMembers } = parsedBody.data;
  const isAllowed = isAdmin;
  if (!isAllowed) {
    return res.status(403).json({ message: "Not Authorized" });
  }

  try {
    await moveTeamToOrg({
      targetOrgId,
      teamId,
      moveMembers,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.statusCode > 300) {
        log.error("moveTeamToOrg failed:", safeStringify(error.message));
      }
      return res.status(error.statusCode).json({ message: error.message });
    }
    log.error("moveTeamToOrg failed:", safeStringify(error));
    return res.status(500).json({ message: (error as any)?.message });
  }

  return res.status(200).json({
    message: `Added team ${teamId} to Org: ${targetOrgId} ${
      moveMembers ? " along with the members" : " without the members"
    }`,
  });
}

/**
 * Make sure that the migration is idempotent
 */
export async function moveTeamToOrg({
  targetOrgId,
  teamId,
  moveMembers,
}: {
  targetOrgId: number;
  teamId: number;
  moveMembers?: boolean;
}) {
  const possibleOrg = await getTeamOrThrowError(targetOrgId);
  const movedTeam = await updateTeam({ teamId, targetOrgId });

  const teamMetadata = teamMetadataSchema.parse(possibleOrg?.metadata);

  if (!teamMetadata?.isOrganization) {
    throw new Error(`${targetOrgId} is not an Org`);
  }

  const targetOrganization = possibleOrg;
  const orgMetadata = teamMetadata;
  await addRedirect(movedTeam.slug, targetOrganization.slug || orgMetadata.requestedSlug || null);
  await setOrgSlugIfNotSet(targetOrganization.slug, orgMetadata, targetOrgId);
  if (moveMembers) {
    for (const membership of movedTeam.members) {
      await migrateUserToOrg({
        user: {
          id: membership.userId,
        },
        targetOrg: {
          id: targetOrgId,
          membership: {
            role: membership.role,
            accepted: membership.accepted,
          },
        },
        isAdmin: true,
      });
    }
  }
  log.debug(`Successfully moved team ${teamId} to org ${targetOrgId}`);
}

async function addRedirect(teamSlug: string | null, orgSlug: string | null) {
  if (!teamSlug) {
    throw new HttpError({
      statusCode: 400,
      message: "No slug for team. Not removing the redirect",
    });
  }
  if (!orgSlug) {
    log.warn(`No slug for org. Not adding the redirect`);
    return;
  }
  const orgUrlPrefix = getOrgFullOrigin(orgSlug);

  await prisma.tempOrgRedirect.upsert({
    where: {
      from_type_fromOrgId: {
        type: RedirectType.Team,
        from: teamSlug,
        fromOrgId: 0,
      },
    },
    create: {
      type: RedirectType.Team,
      from: teamSlug,
      fromOrgId: 0,
      toUrl: `${orgUrlPrefix}/${teamSlug}`,
    },
    update: {
      toUrl: `${orgUrlPrefix}/${teamSlug}`,
    },
  });
}

async function updateTeam({ teamId, targetOrgId }: { teamId: number; targetOrgId: number }) {
  const team = await prisma.team.findUnique({
    where: {
      id: teamId,
    },
    include: {
      members: true,
    },
  });

  if (!team) {
    throw new HttpError({
      statusCode: 400,
      message: `Team with id: ${teamId} not found`,
    });
  }

  if (team.parentId === targetOrgId) {
    log.warn(`Team ${teamId} is already in org ${targetOrgId}`);
    return team;
  }

  await prisma.team.update({
    where: {
      id: teamId,
    },
    data: {
      parentId: targetOrgId,
    },
  });

  return team;
}

async function setOrgSlugIfNotSet(
  orgSlug: string | null,
  orgMetadata: {
    requestedSlug?: string | undefined;
  },
  targetOrgId: number
) {
  if (orgSlug) {
    return;
  }
  if (!orgMetadata.requestedSlug) {
    throw new HttpError({
      statusCode: 400,
      message: `Org with id: ${targetOrgId} doesn't have a slug. Tried using requestedSlug but that's also not present. So, all migration done but failed to set the Organization slug. Please set it manually`,
    });
  }
  await setOrgSlug({
    targetOrgId,
    targetSlug: orgMetadata.requestedSlug,
  });
}

/**
 * Make sure you pass it an organization ID only and not a team ID.
 */
async function setOrgSlug({ targetOrgId, targetSlug }: { targetOrgId: number; targetSlug: string }) {
  await prisma.team.update({
    where: {
      id: targetOrgId,
    },
    data: {
      slug: targetSlug,
    },
  });
}

async function getTeamOrThrowError(targetOrgId: number) {
  const team = await prisma.team.findUnique({
    where: {
      id: targetOrgId,
    },
  });

  if (!team) {
    throw new HttpError({
      statusCode: 400,
      message: `Org with id: ${targetOrgId} not found`,
    });
  }
  return team;
}
