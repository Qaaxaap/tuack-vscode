{
  description = "tuack-vscode 开发环境";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };

        # node 22 + pnpm 11
        nodejs = pkgs.nodejs_22;
        pnpm = pkgs.pnpm_11;
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            nodejs
            pnpm
            pkgs.just
          ];

          shellHook = ''
            echo "tuack-vscode 开发环境"
            echo "  node $(node --version) / pnpm $(pnpm --version) / just $(just --version | cut -d' ' -f2)"
            echo "  常用：just check / just test / just build"
          '';
        };

        # 额外带上编译上游 tuack-ng 与渲染 PDF 的工具（见 src/test/integration）。
        devShells.full = pkgs.mkShell {
          packages = [
            nodejs
            pnpm
            pkgs.just
            pkgs.cargo
            pkgs.rustc
            pkgs.gcc
            pkgs.typst
            pkgs.git
            pkgs.pkg-config
          ];

          shellHook = ''
            echo "tuack-vscode 开发环境（full）"
            echo "  node $(node --version) / pnpm $(pnpm --version) / just $(just --version | cut -d' ' -f2)"
            echo "  cargo $(cargo --version | cut -d' ' -f2) / typst $(typst --version | cut -d' ' -f2)"
          '';
        };
      }
    );
}
