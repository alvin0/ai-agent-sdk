#!/usr/bin/env bash
set -euo pipefail

# Upstream 0.12.0 fixes GHSA-pxhw-h44j-8pfx. Keep the release and digest
# together so CI never falls back to a vulnerable distribution package.
version=0.12.0
archive="bubblewrap-${version}.tar.xz"
sha256=9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314
work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT

apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gcc libcap-dev libselinux1-dev meson ninja-build pkg-config xz-utils
curl --fail --location --silent --show-error \
  "https://github.com/containers/bubblewrap/releases/download/v${version}/${archive}" \
  --output "${work_dir}/${archive}"
printf '%s  %s\n' "$sha256" "${work_dir}/${archive}" | sha256sum --check --status
tar -xJf "${work_dir}/${archive}" -C "$work_dir"
meson setup "${work_dir}/build" "${work_dir}/bubblewrap-${version}" --prefix=/usr
ninja -C "${work_dir}/build"
ninja -C "${work_dir}/build" install
bwrap --version
