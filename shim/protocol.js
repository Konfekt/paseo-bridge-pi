// Shared by the shim and the extension.

/** Prefix of notifications the bridge extension addresses to the shim. */
export const FRAME_MARKER = "PI_PASEO_BRIDGE_FRAME";
/** Set on a Pi child the shim runs, so the extension knows its frames are translated. */
export const SHIM_PROTOCOL_ENV = "PI_PASEO_BRIDGE_SHIM_PROTOCOL";
