#!/bin/bash
# Publish immutable speech model sources and the signed source-lock manifest to
# Cloudflare R2. Content-addressed sources become public before the manifest.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${PROJECT_DIR}/.env"
SOURCE_LOCK="${PROJECT_DIR}/src-tauri/media-worker/model-pack-source-lock.json"
ORIGIN_LOCK="${PROJECT_DIR}/src-tauri/media-worker/model-pack-mirror-origin-lock.json"
TAURI_CONFIG="${PROJECT_DIR}/src-tauri/tauri.conf.json"
R2_BUCKET="myagents-releases"
DOWNLOAD_BASE_URL="https://download.myagents.io"

YES=0
PACKAGE_DIR=""
RCLONE_CONFIG=""
VERIFY_DIR=""
MIRROR_PLAN=""

usage() {
    cat <<'EOF'
Usage: ./publish_speech_model_set.sh [options]

Mirrors the exact locked speech sources, then signs and uploads the compiled
source lock to:
  https://download.myagents.io/models/speech/sets/<pack-revision>/

Mirrored sources use immutable content-addressed paths under:
  https://download.myagents.io/models/speech/assets/sha256/<sha256>/

Options:
  -y, --yes                  Skip interactive confirmation.
  -h, --help                 Show this help.

Required .env keys:
  TAURI_SIGNING_PRIVATE_KEY
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  R2_ACCOUNT_ID

Optional .env keys:
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  CF_ZONE_ID
  CF_API_TOKEN
EOF
}

require_command() {
    local command_name="$1"
    local install_hint="$2"
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Error: missing ${command_name}. ${install_hint}" >&2
        exit 1
    fi
}

cleanup() {
    if [ -n "$RCLONE_CONFIG" ]; then
        rm -f "$RCLONE_CONFIG" 2>/dev/null || true
    fi
    if [ -n "$VERIFY_DIR" ] && [ -d "$VERIFY_DIR" ]; then
        rm -rf "$VERIFY_DIR" 2>/dev/null || true
    fi
    if [ -n "$PACKAGE_DIR" ] && [ -d "$PACKAGE_DIR" ]; then
        rm -rf "$PACKAGE_DIR" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

while [ "$#" -gt 0 ]; do
    case "$1" in
        -y|--yes)
            YES=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage
            exit 1
            ;;
    esac
done

require_command node "Install the bundled development dependencies first."
if [ ! -f "$SOURCE_LOCK" ] || [ ! -f "$ORIGIN_LOCK" ]; then
    echo "Error: speech model source or mirror origin lock is unavailable" >&2
    exit 1
fi
PACK_REVISION=$(node - "$SOURCE_LOCK" <<'NODE'
const { readFileSync } = require('node:fs');
const [lockPath] = process.argv.slice(2);
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
if (
  lock.schemaVersion !== 1
  || typeof lock.packRevision !== 'string'
  || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(lock.packRevision)
) {
  throw new Error(`Invalid speech model source lock: ${lockPath}`);
}
process.stdout.write(lock.packRevision);
NODE
)

PUBLIC_BASE_URL="${DOWNLOAD_BASE_URL}/models/speech/sets/${PACK_REVISION}"
R2_TARGET="r2:${R2_BUCKET}/models/speech/sets/${PACK_REVISION}/"

if [ ! -f "$ENV_FILE" ]; then
    echo "Error: .env file not found" >&2
    exit 1
fi
set +u
# shellcheck disable=SC1090
source "$ENV_FILE"
set -u

for variable_name in TAURI_SIGNING_PRIVATE_KEY R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ACCOUNT_ID; do
    if [ -z "${!variable_name:-}" ]; then
        echo "Error: ${variable_name} is required in .env" >&2
        exit 1
    fi
done

require_command rclone "macOS: brew install rclone."
require_command curl "Install curl."
require_command minisign "macOS: brew install minisign."

echo "Speech model revision: ${PACK_REVISION}"
echo "Files:"
echo "  7 content-addressed model/license sources"
echo "  manifest.json"
echo "  manifest.json.sig"
echo "Target: ${PUBLIC_BASE_URL}/"
if [ "$YES" -ne 1 ]; then
    read -r -p "Upload? (Y/n): " reply
    if [[ "$reply" =~ ^[Nn]$ ]]; then
        echo "Publish cancelled" >&2
        exit 1
    fi
fi

PACKAGE_DIR=$(mktemp -d)
SET_DIR="${PACKAGE_DIR}/sets/${PACK_REVISION}"
MANIFEST_PATH="${SET_DIR}/manifest.json"
SIGNATURE_PATH="${MANIFEST_PATH}.sig"
SOURCE_LOCK_SNAPSHOT="${PACKAGE_DIR}/source-lock.before-mirror.json"
cp "$SOURCE_LOCK" "$SOURCE_LOCK_SNAPSHOT"
node "${PROJECT_DIR}/scripts/prepare-speech-model-mirror.mjs" --out "$PACKAGE_DIR"
MIRROR_PLAN="${PACKAGE_DIR}/mirror-plan.json"
if [ ! -s "$MIRROR_PLAN" ]; then
    echo "Error: speech model mirror plan is unavailable" >&2
    exit 1
fi

VERIFY_DIR=$(mktemp -d)
UPDATER_PUBKEY=$(node - "$TAURI_CONFIG" <<'NODE'
const { readFileSync } = require('node:fs');
const [configPath] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const encodedPublicKey = config?.plugins?.updater?.pubkey;
if (typeof encodedPublicKey !== 'string' || encodedPublicKey.length === 0) {
  throw new Error(`Missing updater public key: ${configPath}`);
}
const publicKeyFile = Buffer.from(encodedPublicKey, 'base64').toString('utf8');
const publicKey = publicKeyFile.split(/\r?\n/).find(line => line.startsWith('RW'));
if (!publicKey) throw new Error(`Invalid updater public key: ${configPath}`);
process.stdout.write(publicKey);
NODE
)

decode_signature() {
    local signature_path="$1"
    local decoded_path="$2"
    node - "$signature_path" "$decoded_path" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [signaturePath, decodedPath] = process.argv.slice(2);
const wrappedSignature = readFileSync(signaturePath, 'utf8').trim();
const decodedSignature = Buffer.from(wrappedSignature, 'base64');
if (decodedSignature.length === 0) throw new Error(`Invalid manifest signature: ${signaturePath}`);
writeFileSync(decodedPath, decodedSignature, { mode: 0o600 });
NODE
}

purge_urls() {
    if [ "$#" -eq 0 ] || [ -z "${CF_ZONE_ID:-}" ] || [ -z "${CF_API_TOKEN:-}" ]; then
        return
    fi
    local payload
    payload=$(node - "$@" <<'NODE'
const urls = process.argv.slice(2);
process.stdout.write(JSON.stringify({ files: urls }));
NODE
)
    local purge_response
    purge_response=$(curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
        -H "Authorization: Bearer ${CF_API_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "$payload")
    if ! echo "$purge_response" | grep -q '"success":true'; then
        echo "Warning: Cloudflare purge did not report success" >&2
    fi
}

REMOTE_MANIFEST_EXISTS=0
REMOTE_SIGNATURE_EXISTS=0
for filename in manifest.json manifest.json.sig; do
    url="${PUBLIC_BASE_URL}/${filename}"
    if ! http_code=$(curl -sS -o /dev/null -w "%{http_code}" -I "$url"); then
        echo "Error: cannot determine whether ${url} exists" >&2
        exit 1
    fi
    case "$http_code" in
        404) ;;
        200)
            if [ "$filename" = "manifest.json" ]; then
                curl -fsSL "$url" -o "${VERIFY_DIR}/remote-manifest.json"
                REMOTE_MANIFEST_EXISTS=1
            else
                curl -fsSL "$url" -o "${VERIFY_DIR}/remote-manifest.json.sig"
                REMOTE_SIGNATURE_EXISTS=1
            fi
            ;;
        *)
            echo "Error: cannot determine whether ${url} exists (HTTP ${http_code})" >&2
            exit 1
            ;;
    esac
done

if [ "$REMOTE_MANIFEST_EXISTS" -eq 1 ] && ! cmp -s "$SOURCE_LOCK_SNAPSHOT" "${VERIFY_DIR}/remote-manifest.json"; then
    echo "Error: immutable remote manifest differs; publish a new packRevision" >&2
    exit 1
fi
if [ "$REMOTE_SIGNATURE_EXISTS" -eq 1 ]; then
    decode_signature "${VERIFY_DIR}/remote-manifest.json.sig" "${VERIFY_DIR}/remote-manifest.minisig"
    if ! minisign -Vm "$SOURCE_LOCK_SNAPSHOT" -x "${VERIFY_DIR}/remote-manifest.minisig" -P "$UPDATER_PUBKEY" >/dev/null; then
        echo "Error: immutable remote signature is invalid; publish a new packRevision" >&2
        exit 1
    fi
fi

RCLONE_CONFIG=$(mktemp)
chmod 600 "$RCLONE_CONFIG"
cat > "$RCLONE_CONFIG" <<EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY_ID}
secret_access_key = ${R2_SECRET_ACCESS_KEY}
endpoint = https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
EOF
RCLONE_ARGS=(--config="$RCLONE_CONFIG" --s3-no-check-bucket --progress --immutable)

SOURCE_IDS=()
SOURCE_URLS=()
SOURCE_REMOTE_PATHS=()
SOURCE_LOCAL_PATHS=()
MISSING_SOURCE_INDEXES=()
source_index=0
while IFS=$'\t' read -r source_id public_url remote_path local_relative_path; do
    local_path="${PACKAGE_DIR}/${local_relative_path}"
    if [ ! -f "$local_path" ]; then
        echo "Error: prepared speech model source is missing: ${source_id}" >&2
        exit 1
    fi
    SOURCE_IDS+=("$source_id")
    SOURCE_URLS+=("$public_url")
    SOURCE_REMOTE_PATHS+=("$remote_path")
    SOURCE_LOCAL_PATHS+=("$local_path")

    if ! http_code=$(curl -sS -o /dev/null -w "%{http_code}" -I "$public_url"); then
        echo "Error: cannot determine whether ${public_url} exists" >&2
        exit 1
    fi
    case "$http_code" in
        200)
            verify_path="${VERIFY_DIR}/source-${source_index}"
            curl -fsSL "$public_url" -o "$verify_path"
            if ! cmp -s "$local_path" "$verify_path"; then
                echo "Error: immutable remote speech model source differs: ${source_id}" >&2
                exit 1
            fi
            ;;
        404)
            MISSING_SOURCE_INDEXES+=("$source_index")
            ;;
        *)
            echo "Error: cannot determine whether ${public_url} exists (HTTP ${http_code})" >&2
            exit 1
            ;;
    esac
    source_index=$((source_index + 1))
done < <(node - "$MIRROR_PLAN" <<'NODE'
const { readFileSync } = require('node:fs');
const [planPath] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
if (plan.schemaVersion !== 1 || !Array.isArray(plan.entries) || plan.entries.length !== 7) {
  throw new Error(`Invalid speech mirror plan: ${planPath}`);
}
for (const entry of plan.entries) {
  for (const value of [entry.id, entry.publicUrl, entry.remotePath, entry.localRelativePath]) {
    if (typeof value !== 'string' || value.length === 0 || /[\t\r\n]/.test(value)) {
      throw new Error(`Invalid speech mirror plan entry: ${entry.id}`);
    }
  }
  process.stdout.write(`${entry.id}\t${entry.publicUrl}\t${entry.remotePath}\t${entry.localRelativePath}\n`);
}
NODE
)

if [ "${#SOURCE_IDS[@]}" -ne 7 ]; then
    echo "Error: speech mirror plan did not produce exactly seven sources" >&2
    exit 1
fi

ASSET_PURGE_URLS=()
for index in "${MISSING_SOURCE_INDEXES[@]}"; do
    rclone "${RCLONE_ARGS[@]}" copyto \
        "${SOURCE_LOCAL_PATHS[$index]}" \
        "r2:${R2_BUCKET}/${SOURCE_REMOTE_PATHS[$index]}"
    ASSET_PURGE_URLS+=("${SOURCE_URLS[$index]}")
done
purge_urls "${ASSET_PURGE_URLS[@]}"

for index in "${MISSING_SOURCE_INDEXES[@]}"; do
    verify_path="${VERIFY_DIR}/source-${index}"
    curl -fsSL "${SOURCE_URLS[$index]}" -o "$verify_path"
    if ! cmp -s "${SOURCE_LOCAL_PATHS[$index]}" "$verify_path"; then
        echo "Error: published speech model source differs: ${SOURCE_IDS[$index]}" >&2
        exit 1
    fi
done

if ! cmp -s "$SOURCE_LOCK_SNAPSHOT" "$SOURCE_LOCK"; then
    echo "Error: source lock changed while preparing publication" >&2
    exit 1
fi
TAURI_SIGNING_PRIVATE_KEY="$TAURI_SIGNING_PRIVATE_KEY" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
    node "${PROJECT_DIR}/scripts/package-speech-model-set.mjs" --out "$PACKAGE_DIR"
if [ ! -f "$MANIFEST_PATH" ] || [ ! -s "$SIGNATURE_PATH" ]; then
    echo "Error: signed speech model manifest output is incomplete" >&2
    exit 1
fi
if ! cmp -s "$SOURCE_LOCK" "$MANIFEST_PATH"; then
    echo "Error: packaged manifest bytes differ from the compiled source lock" >&2
    exit 1
fi
decode_signature "$SIGNATURE_PATH" "${VERIFY_DIR}/local-manifest.minisig"
if ! minisign -Vm "$MANIFEST_PATH" -x "${VERIFY_DIR}/local-manifest.minisig" -P "$UPDATER_PUBKEY" >/dev/null; then
    echo "Error: manifest signature does not match the App updater public key" >&2
    exit 1
fi

MANIFEST_PURGE_URLS=()
if [ "$REMOTE_MANIFEST_EXISTS" -eq 0 ]; then
    rclone "${RCLONE_ARGS[@]}" copyto "$MANIFEST_PATH" "${R2_TARGET}manifest.json"
    MANIFEST_PURGE_URLS+=("${PUBLIC_BASE_URL}/manifest.json")
fi
if [ "$REMOTE_SIGNATURE_EXISTS" -eq 0 ]; then
    rclone "${RCLONE_ARGS[@]}" copyto "$SIGNATURE_PATH" "${R2_TARGET}manifest.json.sig"
    MANIFEST_PURGE_URLS+=("${PUBLIC_BASE_URL}/manifest.json.sig")
fi
purge_urls "${MANIFEST_PURGE_URLS[@]}"

if [ "${#MISSING_SOURCE_INDEXES[@]}" -eq 0 ] && [ "$REMOTE_MANIFEST_EXISTS" -eq 1 ] && [ "$REMOTE_SIGNATURE_EXISTS" -eq 1 ]; then
    echo "Immutable speech model revision and all mirrored sources are already published; no upload needed."
elif [ "${#MISSING_SOURCE_INDEXES[@]}" -gt 0 ]; then
    echo "Published ${#MISSING_SOURCE_INDEXES[@]} missing immutable speech model sources before the manifest."
else
    echo "All immutable speech model sources were already published."
fi

curl -fsSL "${PUBLIC_BASE_URL}/manifest.json" -o "${VERIFY_DIR}/manifest.json"
curl -fsSL "${PUBLIC_BASE_URL}/manifest.json.sig" -o "${VERIFY_DIR}/manifest.json.sig"
cmp -s "$SOURCE_LOCK" "${VERIFY_DIR}/manifest.json" || {
    echo "Error: published manifest bytes do not match the compiled source lock" >&2
    exit 1
}
decode_signature "${VERIFY_DIR}/manifest.json.sig" "${VERIFY_DIR}/published-manifest.minisig"
if ! minisign -Vm "${VERIFY_DIR}/manifest.json" -x "${VERIFY_DIR}/published-manifest.minisig" -P "$UPDATER_PUBKEY" >/dev/null; then
    echo "Error: published signature does not match the App updater public key" >&2
    exit 1
fi

echo "Speech model mirrored sources verified: ${#SOURCE_IDS[@]}"
echo "Speech model manifest published: ${PUBLIC_BASE_URL}/manifest.json"
