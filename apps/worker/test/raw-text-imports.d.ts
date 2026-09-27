// Vite serves a checked-in configuration file as text, so a Worker test can
// assert against the exact deployed values instead of a copied constant.
declare module "*.jsonc?raw" {
  const source: string;
  export default source;
}
