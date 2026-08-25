#!/bin/bash
# Publish the immutable speech model source-lock manifest to Cloudflare R2.
# Upstream model assets remain on their locked official URLs; MyAgents only
# hosts the exact signed manifest consumed by SpeechModelPackManager.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${PROJECT_DIR}/.env"
SOURCE_LOCK="${PROJECT_DIR}/src-tauri/media-worker/model-pack-source-lock.json"
TAURI_CONFIG="${PROJECT_DIR}/src-tauri/tauri.conf.json"
R2_BUCKET="myagents-releases"
DOWNLOAD_BASE_URL="https://download.myagents.io"

YES=0
PACKAGE_DIR=""
RCLONE_CONFIG=""
VERIFY_DIR=""

usage() {
    cat <<'EOF'
Usage: ./publish_speech_model_set.sh [options]

Signs and uploads the exact compiled speech model source lock to:
  https://download.myagents.io/models/speech/sets/<pack-revision>/

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
echo "  manifest-v1.json"
echo "  manifest-v1.json.sig"
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
MANIFEST_PATH="${SET_DIR}/manifest-v1.json"
SIGNATURE_PATH="${MANIFEST_PATH}.sig"
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

decode_signature "$SIGNATURE_PATH" "${VERIFY_DIR}/local-manifest.minisig"
if ! minisign -Vm "$MANIFEST_PATH" -x "${VERIFY_DIR}/local-manifest.minisig" -P "$UPDATER_PUBKEY" >/dev/null; then
    echo "Error: manifest signature does not match the App updater public key" >&2
    exit 1
fi

REMOTE_MANIFEST_EXISTS=0
REMOTE_SIGNATURE_EXISTS=0
for filename in manifest-v1.json manifest-v1.json.sig; do
    url="${PUBLIC_BASE_URL}/${filename}"
    if ! http_code=$(curl -sS -o /dev/null -w "%{http_code}" -I "$url"); then
        echo "Error: cannot determine whether ${url} exists" >&2
        exit 1
    fi
    case "$http_code" in
        404) ;;
        200)
            if [ "$filename" = "manifest-v1.json" ]; then
                curl -fsSL "$url" -o "${VERIFY_DIR}/remote-manifest-v1.json"
                REMOTE_MANIFEST_EXISTS=1
            else
                curl -fsSL "$url" -o "${VERIFY_DIR}/remote-manifest-v1.json.sig"
                REMOTE_SIGNATURE_EXISTS=1
            fi
            ;;
        *)
            echo "Error: cannot determine whether ${url} exists (HTTP ${http_code})" >&2
            exit 1
            ;;
    esac
done

if [ "$REMOTE_MANIFEST_EXISTS" -eq 1 ] && ! cmp -s "$MANIFEST_PATH" "${VERIFY_DIR}/remote-manifest-v1.json"; then
    echo "Error: immutable remote manifest differs; publish a new packRevision" >&2
    exit 1
fi
if [ "$REMOTE_SIGNATURE_EXISTS" -eq 1 ]; then
    decode_signature "${VERIFY_DIR}/remote-manifest-v1.json.sig" "${VERIFY_DIR}/remote-manifest.minisig"
    if ! minisign -Vm "$MANIFEST_PATH" -x "${VERIFY_DIR}/remote-manifest.minisig" -P "$UPDATER_PUBKEY" >/dev/null; then
        echo "Error: immutable remote signature is invalid; publish a new packRevision" >&2
        exit 1
    fi
fi

if [ "$REMOTE_MANIFEST_EXISTS" -eq 0 ] || [ "$REMOTE_SIGNATURE_EXISTS" -eq 0 ]; then
    if ! cmp -s "$SOURCE_LOCK" "$MANIFEST_PATH"; then
        echo "Error: source lock changed while preparing publication" >&2
        exit 1
    fi
    if ! minisign -Vm "$MANIFEST_PATH" -x "${VERIFY_DIR}/local-manifest.minisig" -P "$UPDATER_PUBKEY" >/dev/null; then
        echo "Error: prepared signature changed before publication" >&2
        exit 1
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
    if [ "$REMOTE_MANIFEST_EXISTS" -eq 0 ]; then
        rclone "${RCLONE_ARGS[@]}" copyto "$MANIFEST_PATH" "${R2_TARGET}manifest-v1.json"
    fi
    if [ "$REMOTE_SIGNATURE_EXISTS" -eq 0 ]; then
        rclone "${RCLONE_ARGS[@]}" copyto "$SIGNATURE_PATH" "${R2_TARGET}manifest-v1.json.sig"
    fi
else
    echo "Immutable speech model revision is already published; no upload needed."
fi

if { [ "$REMOTE_MANIFEST_EXISTS" -eq 0 ] || [ "$REMOTE_SIGNATURE_EXISTS" -eq 0 ]; } && [ -n "${CF_ZONE_ID:-}" ] && [ -n "${CF_API_TOKEN:-}" ]; then
    purge_response=$(curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
        -H "Authorization: Bearer ${CF_API_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{\"files\":[\"${PUBLIC_BASE_URL}/manifest-v1.json\",\"${PUBLIC_BASE_URL}/manifest-v1.json.sig\"]}")
    if ! echo "$purge_response" | grep -q '"success":true'; then
        echo "Warning: Cloudflare purge did not report success" >&2
    fi
fi

curl -fsSL "${PUBLIC_BASE_URL}/manifest-v1.json" -o "${VERIFY_DIR}/manifest-v1.json"
curl -fsSL "${PUBLIC_BASE_URL}/manifest-v1.json.sig" -o "${VERIFY_DIR}/manifest-v1.json.sig"
cmp -s "$SOURCE_LOCK" "${VERIFY_DIR}/manifest-v1.json" || {
    echo "Error: published manifest bytes do not match the compiled source lock" >&2
    exit 1
}
decode_signature "${VERIFY_DIR}/manifest-v1.json.sig" "${VERIFY_DIR}/published-manifest.minisig"
if ! minisign -Vm "${VERIFY_DIR}/manifest-v1.json" -x "${VERIFY_DIR}/published-manifest.minisig" -P "$UPDATER_PUBKEY" >/dev/null; then
    echo "Error: published signature does not match the App updater public key" >&2
    exit 1
fi

echo "Speech model manifest published: ${PUBLIC_BASE_URL}/manifest-v1.json"
