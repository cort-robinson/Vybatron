export class PortalError extends Error {
  constructor(status, code, message) { super(message); this.name = 'PortalError'; this.status = status; this.code = code; }
}
export function fail(status, code, message) { throw new PortalError(status, code, message); }
export function safeError(error) {
  if (error instanceof PortalError) return error;
  if (/music queue is busy/.test(error?.message || '')) return new PortalError(429, 'busy', 'The music queue is busy. Try again shortly.');
  if (/cancelled by Stop|favorites changed|mix changed/.test(error?.message || '') || error?.name === 'AbortError') return new PortalError(409, 'changed_session', 'The session or collection changed. Refresh before trying again.');
  if (/favorites hold at most|queue holds at most|server can save|Name your mix/.test(error?.message || '')) return new PortalError(400, 'limit', 'The collection or queue limit was reached, or the mix name is invalid.');
  return new PortalError(503, 'unavailable', 'Vybertron could not complete that request. Refresh and try again.');
}
