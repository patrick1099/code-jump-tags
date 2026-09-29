const path = require("path");
const webpack = require("webpack");

const config = {
  entry: "./src/extension.ts",
  devtool: "source-map",
  externals: {
    vscode: "commonjs vscode"
  },
  resolve: {
    fallback: {
      os: require.resolve("os-browserify/browser"),
      path: require.resolve("path-browserify")
    },
    extensions: [".ts", ".js", ".json"]
  },
  node: {
    __filename: false,
    __dirname: false
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: "ts-loader"
          }
        ]
      }
    ]
  },
  plugins: [
    new webpack.SourceMapDevToolPlugin({
      test: /\.ts$/,
      noSources: false,
      module: true,
      columns: true
    })
  ]
};

const nodeConfig = {
  ...config,
  target: 'node',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension-node.js',
    libraryTarget: "commonjs2",
    devtoolModuleFilenameTemplate: "../[resource-path]",
  }
};

const webConfig = {
  ...config,
  target: 'webworker',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension-web.js',
    libraryTarget: "commonjs2",
    devtoolModuleFilenameTemplate: "../[resource-path]",
  }
};

// cjtag：给 AI / 脚本写标签的命令行入口。它只依赖 lodestar 的纯模块
// (types / tree / relocate)，绝不 import vscode，所以既不要 web worker 那套
// browserify 垫片(它要用真的 node fs)，也不需要把 vscode 列为 external。
const cliConfig = {
  ...config,
  entry: "./src/cli/index.ts",
  target: "node",
  externals: {},
  resolve: {
    extensions: [".ts", ".js", ".json"]
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "cli.js",
    devtoolModuleFilenameTemplate: "../[resource-path]"
  },
  plugins: [
    ...config.plugins,
    new webpack.BannerPlugin({ banner: "#!/usr/bin/env node", raw: true })
  ]
};

module.exports = [nodeConfig, webConfig, cliConfig];