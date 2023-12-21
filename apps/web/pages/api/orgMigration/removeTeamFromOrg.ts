import { getFormSchema } from "@pages/settings/admin/orgMigrations/removeTeamFromOrg";
import { getSession } from "next-auth/react";
import type { NextApiRequest, NextApiResponse } from "next/types";

import { HttpError } from "@calcom/lib/http-error";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import { getTranslation } from "@calcom/lib/server";
import prisma from "@calcom/prisma";
import { Prisma, RedirectType } from "@calcom/prisma/client";
import { UserPermissionRole } from "@calcom/prisma/enums";

const log = logger.getSubLogger({ prefix: ["removeTeamFromOrg"] });

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const rawBody = req.body;
  const translate = await getTranslation("en", "common");
  const removeTeamFromOrgSchema = getFormSchema(translate);
  log.debug(
    "Removing team from org:",
    safeStringify({
      body: rawBody,
    })
  );
  const parsedBody = removeTeamFromOrgSchema.safeParse(rawBody);

  // Don't know why but if I let it go to getSession, it doesn't return the session.  🤯
  req.body = null;

  const session = await getSession({ req });

  if (!session) {
    return res.status(403).json({ message: "No session found" });
  }

  const isAdmin = session.user.role === UserPermissionRole.ADMIN;

  if (!parsedBody.success) {
    log.error("RemoveTeamFromOrg failed:", safeStringify(parsedBody.error));
    return res.status(400).json({ message: JSON.stringify(parsedBody.error) });
  }
  const { teamId, targetOrgId } = parsedBody.data;
  // const isAllowed = !isAdmin ? session.user.id === userId : true;
  const isAllowed = isAdmin;
  if (!isAllowed) {
    return res.status(403).json({ message: "Not Authorized" });
  }

  try {
    await removeTeamFromOrg({
      targetOrgId,
      teamId,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.statusCode > 300) {
        log.error("RemoveTeamFromOrg failed:", safeStringify(error));
      }
      return res.status(error.statusCode).json({ message: error.message });
    }
    log.error("RemoveTeamFromOrg failed:", safeStringify(error));
    return res.status(500).json({ message: (error as any)?.message });
  }

  return res.status(200).json({ message: `Removed team ${teamId} from ${targetOrgId}` });
}

/**
 * Make sure that the migration is idempotent
 */
export async function removeTeamFromOrg({ targetOrgId, teamId }: { targetOrgId: number; teamId: number }) {
  const removedTeam = await updateTeam({ teamId, targetOrgId });

  await removeRedirect(removedTeam.slug);

  log.debug(`Successfully removed team ${teamId} from org ${targetOrgId}`);
}

async function removeRedirect(teamSlug: string | null) {
  if (!teamSlug) {
    throw new HttpError({
      statusCode: 400,
      message: "No slug for team. Not removing the redirect",
    });
    return;
  }

  await prisma.tempOrgRedirect.deleteMany({
    where: {
      type: RedirectType.Team,
      from: teamSlug,
      fromOrgId: 0,
    },
  });
}

async function updateTeam({ teamId, targetOrgId }: { teamId: number; targetOrgId: number }) {
  const team = await prisma.team.findUnique({
    where: {
      id: teamId,
    },
  });

  if (!team) {
    throw new HttpError({
      statusCode: 400,
      message: `Team with id: ${teamId} not found`,
    });
  }

  if (team.parentId !== targetOrgId) {
    log.warn(`Team ${teamId} is not part of org ${targetOrgId}. Not updating`);
    return {
      slug: team.slug,
    };
  }

  try {
    return await prisma.team.update({
      where: {
        id: teamId,
      },
      data: {
        parentId: null,
      },
      select: {
        slug: true,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === "P2002") {
        throw new HttpError({
          message: `Looks like the team's name is already taken by some other team outside the org or an org itself. Please change this team's name or the other team/org's name. If you rename the team that you are trying to remove from the org, you will have to manually remove the redirect from the database for that team as the slug would have changed.`,
          statusCode: 400,
        });
      }
    }
    throw e;
  }
}
