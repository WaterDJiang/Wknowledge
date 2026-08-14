#!/usr/bin/env bash
set -Eeuo pipefail

repository="${1:?repository is required}"
revision="${2:?revision is required}"
deploy_root="/opt/wknowledge"
app_dir="$deploy_root/app"
runtime_env="$deploy_root/runtime.env"
compose=(docker compose --project-name wknowledge --env-file "$runtime_env" -f "$app_dir/docker-compose.yml")

if [[ ! "$repository" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  echo "DEPLOY_REPOSITORY_INVALID" >&2
  exit 2
fi

if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "DEPLOY_REVISION_INVALID" >&2
  exit 2
fi

for command in docker git openssl curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "DEPLOY_COMMAND_MISSING:$command" >&2
    exit 3
  fi
done

umask 077
mkdir -p "$deploy_root"

if [[ ! -f "$runtime_env" ]]; then
  postgres_password="$(openssl rand -hex 32)"
  credential_key="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
  cat > "$runtime_env" <<EOF
POSTGRES_PASSWORD=$postgres_password
WKNOWLEDGE_CREDENTIAL_KEY=$credential_key
WKNOWLEDGE_HTTP_HOST_PORT=127.0.0.1:13000
WKNOWLEDGE_WORKER_MEMORY_LIMIT=512m
WKNOWLEDGE_WORKER_CPU_LIMIT=0.5
WKNOWLEDGE_WORKER_PIDS_LIMIT=128
WKNOWLEDGE_WORKER_TMPFS_SIZE=256m
WKNOWLEDGE_RELEASE_VERSION=$revision
EOF
  chmod 600 "$runtime_env"
fi

if ! grep -qx 'WKNOWLEDGE_HTTP_HOST_PORT=127.0.0.1:13000' "$runtime_env"; then
  echo "DEPLOY_LOOPBACK_PORT_REQUIRED" >&2
  exit 4
fi

if grep -q '^WKNOWLEDGE_RELEASE_VERSION=' "$runtime_env"; then
  sed -i "s/^WKNOWLEDGE_RELEASE_VERSION=.*/WKNOWLEDGE_RELEASE_VERSION=$revision/" "$runtime_env"
else
  printf 'WKNOWLEDGE_RELEASE_VERSION=%s\n' "$revision" >> "$runtime_env"
fi
chmod 600 "$runtime_env"

if [[ ! -d "$app_dir/.git" ]]; then
  git clone --no-checkout "https://github.com/$repository.git" "$app_dir"
fi

git -C "$app_dir" remote set-url origin "https://github.com/$repository.git"
git -C "$app_dir" fetch --depth 1 origin "$revision"
git -C "$app_dir" checkout --detach --force "$revision"
git -C "$app_dir" clean -ffd

"${compose[@]}" config --quiet
docker buildx build --allow network.host --load --tag "wknowledge-app:$revision" --file "$app_dir/deploy/Dockerfile" "$app_dir"
"${compose[@]}" run --rm --no-deps --entrypoint sh web -c 'mkdir -p /app/data/spaces /app/data/blobs'
"${compose[@]}" --profile operations run --rm preflight
"${compose[@]}" up --detach --wait --remove-orphans
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:13000/api/health/ready >/dev/null

echo "DEPLOY_SUCCEEDED revision=$revision"
