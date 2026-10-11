// A shared counter lets memory yield to foreground inference across routes.
let active = 0;
let background = null;
function beginForeground() {
    active++;
    background?.controller.abort(new DOMException('Foreground work takes priority.', 'AbortError'));
    let finished = false;
    return () => { if (!finished) { finished = true; active--; } };
}
function isForegroundBusy() { return active > 0; }
function tryBeginBackground() {
    if (active || background) return null;
    const lease = { controller: new AbortController() };
    background = lease;
    return { signal: lease.controller.signal,
        cancel: () => lease.controller.abort(new DOMException('Background work cancelled.', 'AbortError')),
        release: () => { if (background === lease) background = null; } };
}
module.exports = { beginForeground, isForegroundBusy, tryBeginBackground };
