/**
 * Return the canonical HTTPS origin for a configured dashboard address.
 *
 * Surrounding whitespace and a trailing slash are accepted so configuration
 * copied from a browser or deployment output stays usable. Credentials, a path,
 * query, fragment, or a non-HTTPS scheme make the value invalid. Absent and
 * blank values return null, meaning the dashboard origin is not configured.
 */
export function canonicalDashboardOrigin(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  )
    return null;
  return url.origin;
}
