#!/usr/bin/env bash
# The custom hostname, in two steps, with DNS on Cloudflare (records are DNS-only, not proxied):
#
#   DOMAIN=relay.withadi.dev infra/domain.sh cert   # request the ACM certificate, add its
#                                               # validation CNAME, wait until ISSUED
#   DOMAIN=relay.withadi.dev CERT_ARN=... infra/deploy.sh
#   DOMAIN=relay.withadi.dev infra/domain.sh dns    # CNAME DOMAIN -> the API's regional target
#
# Needs CLOUDFLARE_API_TOKEN (Zone:DNS:Edit on the zone) and the AWS CLI. CF_ZONE defaults to
# the last two labels of DOMAIN.
set -euo pipefail

STACK="${STACK:-adi-analytics}"
export AWS_REGION="${AWS_REGION:-eu-central-1}"
: "${DOMAIN:?set DOMAIN, e.g. relay.withadi.dev}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
CF_ZONE="${CF_ZONE:-$(echo "$DOMAIN" | awk -F. '{print $(NF-1)"."$NF}')}"
CF=https://api.cloudflare.com/client/v4

cf() { curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }
zone_id() { cf "$CF/zones?name=$CF_ZONE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"][0]["id"])'; }

# upsert_cname NAME TARGET: create or update a DNS-only CNAME.
upsert_cname() {
  local zone name="${1%.}" target="${2%.}" id body
  zone="$(zone_id)"
  id="$(cf "$CF/zones/$zone/dns_records?type=CNAME&name=$name" | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(r[0]["id"] if r else "")')"
  body="$(python3 -c 'import json,sys; print(json.dumps({"type":"CNAME","name":sys.argv[1],"content":sys.argv[2],"proxied":False,"ttl":300,"comment":"adi-analytics collector"}))' "$name" "$target")"
  if [ -n "$id" ]; then cf -X PUT "$CF/zones/$zone/dns_records/$id" --data "$body" >/dev/null
  else cf -X POST "$CF/zones/$zone/dns_records" --data "$body" >/dev/null; fi
  echo "CNAME $name -> $target (DNS-only)"
}

find_cert() {
  aws acm list-certificates --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text | grep -v '^None$' || true
}

case "${1:-}" in
  cert)
    arn="$(find_cert)"
    if [ -z "$arn" ]; then
      arn="$(aws acm request-certificate --domain-name "$DOMAIN" --validation-method DNS --query CertificateArn --output text)"
      echo "requested certificate"
    fi
    for _ in $(seq 1 30); do
      rr="$(aws acm describe-certificate --certificate-arn "$arn" --query 'Certificate.DomainValidationOptions[0].ResourceRecord.[Name,Value]' --output text)"
      [ "$rr" != "None" ] && [ -n "$rr" ] && break
      sleep 2
    done
    upsert_cname $rr
    echo "waiting for ACM to issue the certificate (usually a few minutes)"
    aws acm wait certificate-validated --certificate-arn "$arn"
    echo "CERT_ARN=$arn"
    ;;
  dns)
    target="$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='CustomDomainTarget'].OutputValue" --output text)"
    [ -n "$target" ] && [ "$target" != "None" ] || { echo "stack has no CustomDomainTarget: deploy with DOMAIN and CERT_ARN first" >&2; exit 1; }
    upsert_cname "$DOMAIN" "$target"
    ;;
  rm)
    zone="$(zone_id)"
    for id in $(cf "$CF/zones/$zone/dns_records?type=CNAME&name=$DOMAIN" | python3 -c 'import json,sys; print(" ".join(r["id"] for r in json.load(sys.stdin)["result"]))'); do
      cf -X DELETE "$CF/zones/$zone/dns_records/$id" >/dev/null && echo "deleted CNAME $DOMAIN"
    done
    arn="$(find_cert)"
    [ -n "$arn" ] && aws acm delete-certificate --certificate-arn "$arn" && echo "deleted certificate (its validation CNAME is left in place, harmless)"
    ;;
  *)
    echo "usage: DOMAIN=relay.withadi.dev $0 cert|dns|rm" >&2; exit 2 ;;
esac
