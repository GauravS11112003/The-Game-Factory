#!/bin/sh
# Deploy a committed checkout and label every image with its branch and commit.
set -eu
cd "$(dirname "$0")/../.."
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo 'Commit or save working changes before deploying a release.' >&2
  exit 1
fi
DEPLOY_BRANCH=$(git symbolic-ref --quiet --short HEAD) || {
  echo 'Check out the release branch before deploying.' >&2
  exit 1
}
DEPLOY_REVISION=$(git rev-parse HEAD)
export DEPLOY_BRANCH DEPLOY_REVISION
cd deploy/vultr
docker compose "$@" up -d --build
docker compose "$@" ps
printf 'Deployed %s at %s\n' "$DEPLOY_BRANCH" "$DEPLOY_REVISION"
