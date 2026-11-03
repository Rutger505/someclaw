#!/bin/bash
# Links and enables someclaw.service and the update timer. Run from the live checkout ~/.local/share/someclaw. Safe to rerun.
set -e
dir="$(dirname "$(realpath "$0")")"

command -v bun >/dev/null || yay -S --needed --noconfirm bun

mkdir -p "$HOME/.config/systemd/user"
ln -sf "$dir"/systemd/* "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now someclaw.service someclaw-update.timer
