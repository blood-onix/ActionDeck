import { createRepositoryContext } from "../../application/repositories/repository-service";
import { getGitHubSession } from "../providers/github-authentication";
import { chooseRepository } from "../providers/workspace-repositories";

export async function selectRepository(): Promise<ReturnType<typeof createRepositoryContext> | undefined> {
  const choice = await chooseRepository();
  if (!choice) return undefined;
  const session = await getGitHubSession(true);
  if (!session) return undefined;
  return createRepositoryContext(
    choice.folder.uri.toString(),
    choice.remoteName,
    choice.owner,
    choice.repo,
    session.account.id,
  );
}
