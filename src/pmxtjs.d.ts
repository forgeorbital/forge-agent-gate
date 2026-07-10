// Ambient stub for the optional `pmxtjs` dependency.
//
// pmxtjs is NOT a runtime dependency of this package. The pmxt passthrough
// adapter (src/venues/pmxt.ts) loads it lazily only when a pmxt venue is
// configured, and throws a clear "Run `npm install pmxtjs`" error if it is not
// installed. Declaring it here lets the package build and type-check without
// pulling pmxtjs (and its axios/tsx/esbuild subtree) into every install.
declare module "pmxtjs";
