import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import { nodeResolve } from "@rollup/plugin-node-resolve";

const config = {
  input: "src/cleanup.js",
  output: {
    esModule: true,
    file: "dist/cleanup.js",
    inlineDynamicImports: true,
    format: "es",
    sourcemap: true,
  },
  plugins: [json(), commonjs(), nodeResolve({ preferBuiltins: true })],
};

export default config;
