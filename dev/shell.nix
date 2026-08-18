# Mobile-dev shell — the phone tooling for dev/install-android.sh:
#   adb (android-tools)  → install the APK on a USB-connected Android phone
#   gh                   → download the dsh-debug-apk artifact from Actions
#   nodejs               → Capacitor CLI (npx cap sync, mobile scripts)
#
# Direnv loads this when you cd into dev/ (dev/.envrc does `use nix`).
{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  packages = with pkgs; [
    android-tools
    gh
    nodejs
  ];
}
