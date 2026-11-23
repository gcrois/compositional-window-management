{
  description = "Compositional window management: the web app and its Domicile desktop shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      each = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # `nix develop`, then `npm install`, `npm run dev`, `npm test`, `npm run build:shell`.
      devShells = each (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.nodejs ]; };
      });
    };
}
