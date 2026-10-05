/** The longest address recorded; anything longer is not a gif service's URL. */
const MAX_SOURCE_URL_LENGTH = 2048;

/**
 * The one form a gif address is recorded and looked up in (`gif_sources.url`).
 *
 * The same gif turns up as `HTTPS://Media.Giphy.com/a.gif`, with a trailing
 * `#fragment` from a copied link, or with an explicit `:443`; all of those must
 * land on one row. The rule is deliberately small:
 *
 * - https only. An http address is not recorded at all (null), since the services
 *   this is for all serve https and an http copy could be swapped in transit;
 * - credentials in the address are refused (null);
 * - the host is lowercased and a default port is dropped (what `URL` does);
 * - the fragment is dropped, because it never reaches the server;
 * - the path and the query string are kept exactly as given. Services such as
 *   Klipy and Tenor can select the file by a query parameter, so two addresses
 *   differing only in a query are two different gifs until proven otherwise.
 *
 * Returns null for anything that is not a usable address.
 */
export function normalizeGifSourceUrl(value: string): string | null {
  if (value.length > MAX_SOURCE_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  url.hash = '';
  const normalized = url.toString();
  return normalized.length > MAX_SOURCE_URL_LENGTH ? null : normalized;
}
