import { getFormSchema } from "@pages/settings/admin/orgMigrations/removeUserFromOrg";
import { getSession } from "next-auth/react";
import type { NextApiRequest, NextApiResponse } from "next/types";

import { HttpError } from "@calcom/lib/http-error";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import { getTranslation } from "@calcom/lib/server";
import type { User } from "@calcom/prisma/client";
import { RedirectType } from "@calcom/prisma/client";
import { UserPermissionRole } from "@calcom/prisma/enums";
import { teamMetadataSchema } from "@calcom/prisma/zod-utils";

const log = logger.getSubLogger({ prefix: ["removeUserFromOrg"] });

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const body = req.body;

  log.debug(
    "Starting reverse migration:",
    safeStringify({
      body,
    })
  );

  const translate = await getTranslation("en", "common");
  const migrateRevertBodySchema = getFormSchema(translate);
  const parsedBody = migrateRevertBodySchema.safeParse(body);

  // Don't know why but if I let it go to getSession, it doesn't return the session.  🤯
  req.body = null;

  const session = await getSession({ req });

  if (!session) {
    return res.status(403).json({ message: "No session found" });
  }

  const isAdmin = session.user.role === UserPermissionRole.ADMIN;
  if (!isAdmin) {
    return res.status(403).json({ message: "Only admin can take this action" });
  }
  const prisma = (await import("@calcom/prisma")).default;

  if (parsedBody.success) {
    const { userId, targetOrgId } = parsedBody.data;
    try {
      await removeFromOrg({ prisma, targetOrgId, userId });
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.statusCode > 300) {
          log.error("Reverse migration failed:", safeStringify(error));
        }
        return res.status(error.statusCode).json({ message: error.message });
      }
      log.error("Reverse migration failed:", safeStringify(error));
      return res.status(500).json({ message: (error as any)?.message });
    }
    return res.status(200).json({ message: "Reverted" });
  }
  log.error("Reverse Migration failed:", safeStringify(parsedBody.error));
  return res.status(400).json({ message: JSON.stringify(parsedBody.error) });
}

/**
 * Make sure that the migration is idempotent
 */
export async function removeFromOrg({
  prisma,
  targetOrgId,
  userId,
}: {
  targetOrgId: number;
  userId: number;
  prisma: Awaited<typeof import("@calcom/prisma")>["default"];
}) {
  const userToRemoveFromOrg = await prisma.user.findUnique({
    where: {
      id: userId,
    },
  });

  if (!userToRemoveFromOrg) {
    throw new HttpError({
      statusCode: 400,
      message: `User with id: ${userId} not found`,
    });
  }

  if (userToRemoveFromOrg.organizationId !== targetOrgId) {
    throw new HttpError({
      statusCode: 400,
      message: `User with id: ${userId} is not part of orgId: ${targetOrgId}`,
    });
  }

  const userToRemoveFromOrgMetadata = (userToRemoveFromOrg.metadata || {}) as {
    migratedToOrgFrom?: {
      username: string;
      reverted: boolean;
      revertTime: string;
      lastMigrationTime: string;
    };
  };

  if (!userToRemoveFromOrgMetadata.migratedToOrgFrom) {
    throw new HttpError({
      statusCode: 400,
      message: `User with id: ${userId} wasn't migrated. So, there is nothing to revert`,
    });
  }

  if (userToRemoveFromOrgMetadata.migratedToOrgFrom.reverted) {
    throw new HttpError({
      statusCode: 400,
      message: `User with id: ${userId} is already reverted`,
    });
  }

  const nonOrgUserName = userToRemoveFromOrgMetadata.migratedToOrgFrom.username as string;
  if (!nonOrgUserName) {
    throw new HttpError({
      statusCode: 500,
      message: `User with id: ${userId} doesn't have a non-org username`,
    });
  }

  const teamsToBeRemovedFromOrg = await updateTeams({ prisma, userToRemoveFromOrg });
  await updateUser({ prisma, userToRemoveFromOrg, nonOrgUserName });

  await removeRedirect({ nonOrgUserName, teamsToBeRemovedFromOrg, prisma });
  await removeMembership({ prisma, targetOrgId, userToRemoveFromOrg });

  log.debug(`orgId:${targetOrgId} attached to userId:${userId}`);
}

async function removeRedirect({
  nonOrgUserName,
  teamsToBeRemovedFromOrg,
  prisma,
}: {
  nonOrgUserName: string | null;
  teamsToBeRemovedFromOrg: { slug: string | null }[];
  prisma: Awaited<typeof import("@calcom/prisma")>["default"];
}) {
  if (!nonOrgUserName) {
    return;
  }

  await prisma.tempOrgRedirect.deleteMany({
    // This where clause is unique, so we will get only one result but using deleteMany because it doesn't throw an error if there are no rows to delete
    where: {
      type: RedirectType.User,
      from: nonOrgUserName,
      fromOrgId: 0,
    },
  });

  for (const [, team] of Object.entries(teamsToBeRemovedFromOrg)) {
    if (!team.slug) {
      log.debug("No slug for team. Not removing the redirect", safeStringify({ team }));
      continue;
    }
    await prisma.tempOrgRedirect.deleteMany({
      where: {
        type: RedirectType.Team,
        from: team.slug,
        fromOrgId: 0,
      },
    });
  }
}

async function removeMembership({
  prisma,
  targetOrgId,
  userToRemoveFromOrg,
}: {
  prisma: Awaited<typeof import("@calcom/prisma")>["default"];
  targetOrgId: number;
  userToRemoveFromOrg: User;
}) {
  await prisma.membership.delete({
    where: {
      userId_teamId: {
        teamId: targetOrgId,
        userId: userToRemoveFromOrg.id,
      },
    },
  });
}

async function updateUser({
  prisma,
  userToRemoveFromOrg,
  nonOrgUserName,
}: {
  prisma: Awaited<typeof import("@calcom/prisma")>["default"];
  userToRemoveFromOrg: User;
  nonOrgUserName: string;
}) {
  await prisma.user.update({
    where: {
      id: userToRemoveFromOrg.id,
    },
    data: {
      organizationId: null,
      username: nonOrgUserName,
      metadata: {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        ...(userToRemoveFromOrg.metadata || {}),
        migratedToOrgFrom: {
          username: null,
          reverted: true,
          revertTime: new Date().toISOString(),
        },
      },
    },
  });
}

async function updateTeams({
  prisma,
  userToRemoveFromOrg,
}: {
  prisma: Awaited<typeof import("@calcom/prisma")>["default"];
  userToRemoveFromOrg: User;
}) {
  const memberships = await prisma.membership.findMany({
    where: {
      userId: userToRemoveFromOrg.id,
    },
  });

  const membershipTeamIds = memberships.map((m) => m.teamId);
  const teams = await prisma.team.findMany({
    where: {
      id: {
        in: membershipTeamIds,
      },
    },
    select: {
      id: true,
      slug: true,
      metadata: true,
    },
  });

  const teamsToBeRemovedFromOrg = teams
    .map((team) => {
      return {
        ...team,
        metadata: teamMetadataSchema.parse(team.metadata),
      };
    })
    // Remove Orgs from the list
    .filter((team) => !team.metadata?.isOrganization);

  const teamIdsToBeRemovedFromOrg = teamsToBeRemovedFromOrg.map((t) => t.id);

  if (memberships.length) {
    // Remove the user's teams from the org
    await prisma.team.updateMany({
      where: {
        id: {
          in: teamIdsToBeRemovedFromOrg,
        },
      },
      data: {
        parentId: null,
      },
    });
  }
  return teamsToBeRemovedFromOrg;
}
