#!/usr/bin/env bash
# Builds the collector, deploys the CloudFormation stack and uploads the Lambda code.
#
#   AWS_REGION=eu-central-1 infra/deploy.sh
#
# Environment (all optional):
#   STACK                 stack name, default adi-analytics
#   AWS_REGION            region, default eu-central-1
#   ALLOWED_ORIGINS       default https://withadi.dev,https://www.withadi.dev
#   DOMAIN, CERT_ARN      custom hostname + its ACM certificate (see infra/domain.sh)
#   ANALYTICS_WRITE_KEY   server write key; ANALYTICS_EXPORT_KEY  export key.
#                         Only their SHA-256 hashes are deployed. On the first deploy, missing
#                         keys are generated and written to .deploy/keys.env (mode 600). On
#                         later deploys, missing keys keep the hashes already deployed.
set -euo pipefail
cd "$(dirname "$0")/.."

STACK="${STACK:-adi-analytics}"
export AWS_REGION="${AWS_REGION:-eu-central-1}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://withadi.dev,https://www.withadi.dev}"

command -v aws >/dev/null || { echo "aws CLI v2 is required" >&2; exit 1; }
command -v bun >/dev/null || { echo "bun is required" >&2; exit 1; }
aws sts get-caller-identity --query Arn --output text >/dev/null

sha256() { printf %s "$1" | openssl dgst -sha256 -r | cut -d' ' -f1; }
newkey() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '='; }

stack_exists=false
aws cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1 && stack_exists=true

params=("AllowedOrigins=$ALLOWED_ORIGINS")
if ! $stack_exists; then
  mkdir -p .deploy && chmod 700 .deploy
  if [ -z "${ANALYTICS_WRITE_KEY:-}" ] || [ -z "${ANALYTICS_EXPORT_KEY:-}" ]; then
    ANALYTICS_WRITE_KEY="${ANALYTICS_WRITE_KEY:-$(newkey)}"
    ANALYTICS_EXPORT_KEY="${ANALYTICS_EXPORT_KEY:-$(newkey)}"
    umask 077
    printf 'ANALYTICS_WRITE_KEY=%s\nANALYTICS_EXPORT_KEY=%s\n' "$ANALYTICS_WRITE_KEY" "$ANALYTICS_EXPORT_KEY" > .deploy/keys.env
    echo "generated keys in .deploy/keys.env: store them in your secret manager, then delete the file"
  fi
fi
[ -n "${ANALYTICS_WRITE_KEY:-}" ] && params+=("WriteKeyHashes=$(sha256 "$ANALYTICS_WRITE_KEY")")
[ -n "${ANALYTICS_EXPORT_KEY:-}" ] && params+=("ExportKeyHashes=$(sha256 "$ANALYTICS_EXPORT_KEY")")
if [ -n "${DOMAIN:-}" ]; then
  [ -n "${CERT_ARN:-}" ] || { echo "DOMAIN needs CERT_ARN (run infra/domain.sh)" >&2; exit 1; }
  params+=("DomainName=$DOMAIN" "CertificateArn=$CERT_ARN")
fi

echo "== build"
bun install --frozen-lockfile >/dev/null
bun run test
bun run build
python3 - <<'EOF'
import zipfile
with zipfile.ZipFile("dist/lambda.zip", "w", zipfile.ZIP_DEFLATED) as z:
    z.write("dist/lambda/index.mjs", "index.mjs")
EOF

echo "== deploy stack $STACK in $AWS_REGION"
aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file infra/template.yaml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${params[@]}"

out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
FN="$(out FunctionName)"

echo "== upload code to $FN"
aws lambda update-function-code --function-name "$FN" --zip-file fileb://dist/lambda.zip --architectures arm64 >/dev/null
aws lambda wait function-updated-v2 --function-name "$FN"

API="$(out ApiEndpoint)"
echo "== health: $(curl -fsS "$API/health")"
echo "endpoint:   $API"
echo "public url: $(out PublicUrl)"
[ -n "${DOMAIN:-}" ] && echo "CNAME $DOMAIN -> $(out CustomDomainTarget) (infra/domain.sh dns does this)"
echo "smoke test: API=$API infra/smoke.sh"
