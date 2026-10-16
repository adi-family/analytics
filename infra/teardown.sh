#!/usr/bin/env bash
# Deletes the stack and every event it collected. Irreversible.
#
#   infra/teardown.sh --yes
#
# The custom domain's CNAME and certificate are separate: DOMAIN=... infra/domain.sh rm
set -euo pipefail

STACK="${STACK:-adi-analytics}"
export AWS_REGION="${AWS_REGION:-eu-central-1}"
[ "${1:-}" = "--yes" ] || { echo "this deletes stack $STACK in $AWS_REGION and all collected events; rerun with --yes" >&2; exit 2; }

bucket="$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='EventsBucketName'].OutputValue" --output text)"
if [ -n "$bucket" ] && [ "$bucket" != "None" ]; then
  echo "== emptying s3://$bucket"
  aws s3 rm "s3://$bucket" --recursive --only-show-errors
fi
echo "== deleting stack $STACK"
aws cloudformation delete-stack --stack-name "$STACK"
aws cloudformation wait stack-delete-complete --stack-name "$STACK"
echo "deleted"
