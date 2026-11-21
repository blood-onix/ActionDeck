export function parseSupportedGitHubRunUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !/^\/[^/]+\/[^/]+\/actions\/runs\/\d+\/?$/.test(url.pathname)
    ) return undefined;
    return url;
  } catch {
    return undefined;
  }
}
