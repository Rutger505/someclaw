#!/bin/bash
# Installs deps, builds dist/, links and enables someclaw.service and the update timer. Run from the live checkout
# ~/.local/share/someclaw. Safe to rerun.
set -e
dir="$(dirname "$(realpath "$0")")"
cd "$dir"

command -v bun >/dev/null || yay -S --needed --noconfirm bun
bun install --frozen-lockfile
bun run build

mkdir -p "$HOME/.config/systemd/user"
ln -sf "$dir"/systemd/* "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now someclaw.service someclaw-update.timer
