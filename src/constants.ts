// Lodestar (fork of CodeTour). Licensed under the MIT License.
import { Uri } from "vscode";

export const EXTENSION_NAME = "codeJumpTags";

// Id of the in-memory "ambient" tour used by Lodestar's edit-mode toggle to
// force the comment CommentController to exist (so the gutter "+" appears). It
// is never persisted and must stay invisible to the user (no sidebar node, no
// status-bar item).
export const AMBIENT_TOUR_ID = `${EXTENSION_NAME}:ambient`;

export const FS_SCHEME = EXTENSION_NAME;
export const FS_SCHEME_CONTENT = `${FS_SCHEME}-content`;
export const CONTENT_URI = Uri.parse(`${FS_SCHEME_CONTENT}://current/CodeJumpTags`);

// Code Jump Tags brand icons, inlined as SVG data URIs so they're
// self-contained (no network) and work uniformly for the gutter marker, the
// comment-box avatar, and notebook markdown. ICON_URL = the ⌖ crosshair gutter
// marker (tag-yellow); SMALL_ICON_URL = the blue brand square avatar.
export const ICON_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxNicgaGVpZ2h0PScxNicgdmlld0JveD0nMCAwIDE2IDE2Jz48ZyBmaWxsPSdub25lJyBzdHJva2U9JyNmNmU4OWEnIHN0cm9rZS13aWR0aD0nMS40JyBzdHJva2UtbGluZWNhcD0ncm91bmQnPjxjaXJjbGUgY3g9JzgnIGN5PSc4JyByPSczLjYnLz48cGF0aCBkPSdNOCAxdjIuNk04IDEyLjRWMTVNMSA4aDIuNk0xMi40IDhIMTUnLz48L2c+PGNpcmNsZSBjeD0nOCcgY3k9JzgnIHI9JzEuMycgZmlsbD0nI2Y2ZTg5YScvPjwvc3ZnPg==";
export const SMALL_ICON_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPSc0MCcgaGVpZ2h0PSc0MCcgdmlld0JveD0nMCAwIDQwIDQwJz48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9J2cnIHgxPScwJyB5MT0nMCcgeDI9JzEnIHkyPScxJz48c3RvcCBvZmZzZXQ9JzAnIHN0b3AtY29sb3I9JyM0ZWExZmYnLz48c3RvcCBvZmZzZXQ9JzEnIHN0b3AtY29sb3I9JyMyYjZmYzInLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cmVjdCB3aWR0aD0nNDAnIGhlaWdodD0nNDAnIHJ4PScxMCcgZmlsbD0ndXJsKCNnKScvPjxnIGZpbGw9J25vbmUnIHN0cm9rZT0nI2ZmZicgc3Ryb2tlLXdpZHRoPScyLjInIHN0cm9rZS1saW5lY2FwPSdyb3VuZCc+PGNpcmNsZSBjeD0nMjAnIGN5PScyMCcgcj0nNy41Jy8+PHBhdGggZD0nTTIwIDV2NU0yMCAzMHY1TTUgMjBoNU0zMCAyMGg1Jy8+PC9nPjxjaXJjbGUgY3g9JzIwJyBjeT0nMjAnIHI9JzIuNicgZmlsbD0nI2ZmZicvPjwvc3ZnPg==";

// A fully transparent avatar so the preview note comment shows no icon (omitting
// iconPath would render a black square instead).
export const BLANK_ICON_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPSc0MCcgaGVpZ2h0PSc0MCcgdmlld0JveD0nMCAwIDQwIDQwJy8+";

// Shared text for the comment input box, so the "+" (create) box and the note
// (edit) box read identically instead of VS Code's default "开始讨论". `prompt`
// shows on the collapsed input; `placeHolder` shows once it's focused.
export const NOTE_INPUT_PROMPT = "注释";
export const NOTE_INPUT_PLACEHOLDER = "输入注释内容…";

export const VSCODE_DIRECTORY = ".vscode";

export const STORE_DIRECTORY = ".code-jump-tags";
export const STORE_FILE = "store.json";
