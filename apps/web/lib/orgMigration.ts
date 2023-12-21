import { getOrgUsernameFromEmail } from "@calcom/features/auth/signup/utils/getOrgUsernameFromEmail";
import { getOrgFullOrigin } from "@calcom/features/ee/organizations/lib/orgDomains";
import { HttpError } from "@calcom/lib/http-error";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import prisma from "@calcom/prisma";
import type { Team, User } from "@calcom/prisma/client";
import { RedirectType } from "@calcom/prisma/client";
import type { MembershipRole } from "@calcom/prisma/enums";
import { teamMetadataSchema } from "@calcom/prisma/zod-utils";

const log = logger.getSubLogger({ prefix: ["orgMigration"] });

type UserMetadata = {
  migratedToOrgFrom?: {
    username: string;
    reverted: boolean;
    revertTime: string;
    lastMigrationTime: string;
  };
};

/**
 * Make sure that the migration is idempotent
 */
export async function migrateUserToOrg({
  user: { id: userId, userName: userName },
  targetOrg: {
    id: targetOrgId,
    username: targetOrgUsername,
    membership: { role: targetOrgRole, accepted: targetOrgMembershipAccepted = true },
  },
}: {
  user: { id?: number; userName?: string };
  targetOrg: {
    id: number;
    username?: string;
    membership: { role: MembershipRole; accepted?: boolean };
  };
}) {
  assertUserIdOrUserName(userId, userName);
  const team = await getTeamOrThrowError(targetOrgId);

  const teamMetadata = teamMetadataSchema.parse(team?.metadata);

  if (!teamMetadata?.isOrganization) {
    throw new Error(`${targetOrgId} is not an Org`);
  }

  const targetOrganization = {
    ...team,
    metadata: teamMetadata,
  };
  const userToMoveToOrg = await getUniqueUserThatDoesntBelongToOrg(userName, userId, targetOrgId);
  assertUserPartOfOtherOrg(userToMoveToOrg, userName, userId, targetOrgId);

  if (!targetOrgUsername) {
    targetOrgUsername = getOrgUsernameFromEmail(
      userToMoveToOrg.email,
      targetOrganization.metadata.orgAutoAcceptEmail || ""
    );
  }

  const userWithSameUsernameInOrg = await prisma.user.findFirst({
    where: {
      username: targetOrgUsername,
      organizationId: targetOrgId,
    },
  });

  log.debug({
    userWithSameUsernameInOrg,
    targetOrgUsername,
    targetOrgId,
    userId,
  });

  if (userWithSameUsernameInOrg && userWithSameUsernameInOrg.id !== userId) {
    throw new HttpError({
      statusCode: 400,
      message: `Username ${targetOrgUsername} already exists for orgId: ${targetOrgId} for some other user`,
    });
  }

  assertUserPartOfOrgAndRemigrationAllowed(userToMoveToOrg, targetOrgId, targetOrgUsername, userId);

  const orgMetadata = teamMetadata;

  const userToMoveToOrgMetadata = (userToMoveToOrg.metadata || {}) as UserMetadata;

  const nonOrgUserName =
    (userToMoveToOrgMetadata.migratedToOrgFrom?.username as string) || userToMoveToOrg.username;
  if (!nonOrgUserName) {
    throw new HttpError({
      statusCode: 400,
      message: `User with id: ${userId} doesn't have a non-org username`,
    });
  }

  await updateUser({ userToMoveToOrg, targetOrgId, targetOrgUsername, nonOrgUserName });

  const teamsToBeMovedToOrg = await updateTeams({ targetOrgId, userToMoveToOrg });

  await updateMembership({ targetOrgId, userToMoveToOrg, targetOrgRole, targetOrgMembershipAccepted });

  await addRedirect({
    nonOrgUserName,
    teamsToBeMovedToOrg,
    organization: targetOrganization,
    targetOrgUsername,
  });

  await setOrgSlugIfNotSet(targetOrganization, orgMetadata, targetOrgId);

  log.debug(`orgId:${targetOrgId} attached to userId:${userId}`);
}

async function getUniqueUserThatDoesntBelongToOrg(
  userName: string | undefined,
  userId: number | undefined,
  excludeOrgId: number
) {
  if (userName) {
    const matchingUsers = await prisma.user.findMany({
      where: {
        username: userName,
      },
    });
    const foundUsers = matchingUsers.filter(
      (user) => user.organizationId === excludeOrgId || user.organizationId === null
    );
    if (foundUsers.length > 1) {
      throw new Error(`More than one user found with username: ${userName}`);
    }
    return foundUsers[0];
  } else {
    return await prisma.user.findUnique({
      where: {
        id: userId,
      },
    });
  }
}

async function setOrgSlugIfNotSet(
  targetOrganization: {
    slug: string | null;
  },
  orgMetadata: {
    requestedSlug?: string | undefined;
  },
  targetOrgId: number
) {
  if (targetOrganization.slug) {
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

function assertUserPartOfOrgAndRemigrationAllowed(
  userToMoveToOrg: {
    organizationId: User["organizationId"];
  },
  targetOrgId: number,
  targetOrgUsername: string,
  userId: number | undefined
) {
  if (userToMoveToOrg.organizationId) {
    if (userToMoveToOrg.organizationId !== targetOrgId) {
      throw new HttpError({
        statusCode: 400,
        message: `User ${targetOrgUsername} already exists for different Org with orgId: ${targetOrgId}`,
      });
    } else {
      log.debug(`Redoing migration for userId: ${userId} to orgId:${targetOrgId}`);
    }
  }
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

function assertUserPartOfOtherOrg(
  userToMoveToOrg: {
    organizationId: User["organizationId"];
  } | null,
  userName: string | undefined,
  userId: number | undefined,
  targetOrgId: number
): asserts userToMoveToOrg {
  if (!userToMoveToOrg) {
    throw new HttpError({
      message: `User ${userName ? userName : `ID:${userId}`} is part of an org already`,
      statusCode: 400,
    });
  }

  if (userToMoveToOrg.organizationId && userToMoveToOrg.organizationId !== targetOrgId) {
    throw new HttpError({ message: `User is already a part of an organization`, statusCode: 400 });
  }
}

function assertUserIdOrUserName(userId: number | undefined, userName: string | undefined) {
  if (!userId && !userName) {
    throw new HttpError({ statusCode: 400, message: "userId or userName is required" });
  }
  if (userId && userName) {
    throw new HttpError({ statusCode: 400, message: "Provide either userId or userName" });
  }
}

async function addRedirect({
  nonOrgUserName,
  organization,
  targetOrgUsername,
  teamsToBeMovedToOrg,
}: {
  nonOrgUserName: string | null;
  organization: Team;
  targetOrgUsername: string;
  teamsToBeMovedToOrg: { slug: string | null }[];
}) {
  if (!nonOrgUserName) {
    return;
  }
  const orgSlug = organization.slug || (organization.metadata as { requestedSlug?: string })?.requestedSlug;
  if (!orgSlug) {
    log.debug("No slug for org. Not adding the redirect", safeStringify({ organization, nonOrgUserName }));
    return;
  }
  // If the user had a username earlier, we need to redirect it to the new org username
  const orgUrlPrefix = getOrgFullOrigin(orgSlug);
  log.debug({
    orgUrlPrefix,
    nonOrgUserName,
    targetOrgUsername,
  });

  await prisma.tempOrgRedirect.upsert({
    where: {
      from_type_fromOrgId: {
        type: RedirectType.User,
        from: nonOrgUserName,
        fromOrgId: 0,
      },
    },
    create: {
      type: RedirectType.User,
      from: nonOrgUserName,
      fromOrgId: 0,
      toUrl: `${orgUrlPrefix}/${targetOrgUsername}`,
    },
    update: {
      toUrl: `${orgUrlPrefix}/${targetOrgUsername}`,
    },
  });

  for (const [, team] of Object.entries(teamsToBeMovedToOrg)) {
    if (!team.slug) {
      log.debug("No slug for team. Not adding the redirect", safeStringify({ team }));
      continue;
    }
    await prisma.tempOrgRedirect.upsert({
      where: {
        from_type_fromOrgId: {
          type: RedirectType.Team,
          from: team.slug,
          fromOrgId: 0,
        },
      },
      create: {
        type: RedirectType.Team,
        from: team.slug,
        fromOrgId: 0,
        toUrl: `${orgUrlPrefix}/team/${team.slug}`,
      },
      update: {
        toUrl: `${orgUrlPrefix}/team/${team.slug}`,
      },
    });
  }
}

async function updateMembership({
  targetOrgId,
  userToMoveToOrg,
  targetOrgRole,
  targetOrgMembershipAccepted,
}: {
  targetOrgId: number;
  userToMoveToOrg: User;
  targetOrgRole: MembershipRole;
  targetOrgMembershipAccepted: boolean;
}) {
  await prisma.membership.upsert({
    where: {
      userId_teamId: {
        teamId: targetOrgId,
        userId: userToMoveToOrg.id,
      },
    },
    create: {
      teamId: targetOrgId,
      userId: userToMoveToOrg.id,
      role: targetOrgRole,
      accepted: targetOrgMembershipAccepted,
    },
    update: {
      role: targetOrgRole,
      accepted: targetOrgMembershipAccepted,
    },
  });
}

async function updateUser({
  userToMoveToOrg,
  targetOrgId,
  targetOrgUsername,
  nonOrgUserName,
}: {
  userToMoveToOrg: User;
  targetOrgId: number;
  targetOrgUsername: string;
  nonOrgUserName: string | null;
}) {
  await prisma.user.update({
    where: {
      id: userToMoveToOrg.id,
    },
    data: {
      organizationId: targetOrgId,
      username: targetOrgUsername,
      metadata: {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        ...(userToMoveToOrg.metadata || {}),
        migratedToOrgFrom: {
          username: nonOrgUserName,
          lastMigrationTime: new Date().toISOString(),
        },
      },
    },
  });
}

async function updateTeams({ targetOrgId, userToMoveToOrg }: { targetOrgId: number; userToMoveToOrg: User }) {
  const memberships = await prisma.membership.findMany({
    where: {
      userId: userToMoveToOrg.id,
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

  const teamsToBeMovedToOrg = teams
    .map((team) => {
      return {
        ...team,
        metadata: teamMetadataSchema.parse(team.metadata),
      };
    })
    // Remove Orgs from the list
    .filter((team) => !team.metadata?.isOrganization);

  const teamIdsToBeMovedToOrg = teamsToBeMovedToOrg.map((t) => t.id);

  if (memberships.length) {
    // Add the user's teams to the org
    await prisma.team.updateMany({
      where: {
        id: {
          in: teamIdsToBeMovedToOrg,
        },
      },
      data: {
        parentId: targetOrgId,
      },
    });
  }
  return teamsToBeMovedToOrg;
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
