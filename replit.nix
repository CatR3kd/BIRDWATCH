{ pkgs }: {
	deps = [
		pkgs.git config --global core.excludesfile ~/.gitignore_global
  pkgs.nodejs-16_x
        pkgs.nodePackages.typescript-language-server
        pkgs.yarn
        pkgs.replitPackages.jest
	];
}