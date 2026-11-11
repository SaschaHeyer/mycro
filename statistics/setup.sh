#!/usr/bin/env bash
# Infrastructure and deploy for the statistics page, driven by statistics.json. Safe to rerun.
#   bash setup.sh                          # everything for the modules switched on
#   bash setup.sh --copy-dataforseo        # also copies the DataForSEO login (rankings.dataforseo_secret_project)
#   bash setup.sh --copy-asc-key P:SECRET  # also copies the App Store Connect .p8 from project P, secret SECRET
#   MAP_DOMAINS=1 bash setup.sh            # also maps admin_host to the admin service
# Google Play: the transfer itself is created by hand once Play Console has a reports bucket (manual-steps.md).
# By hand (see the skill's references/manual-steps.md): the IAP OAuth client in a project without an
# organisation, the DNS record for admin_host, the rank job's account as a Search Console user, and the
# Stripe key secret when growth.revenue is "stripe".
set -euo pipefail
cd "$(dirname "$0")"
[[ -f statistics.json ]] || { echo "statistics.json missing: copy statistics.example.json and fill it in" >&2; exit 1; }

# Read statistics.json into shell variables.
eval "$(python3 - <<'PY'
import json, shlex
c = json.load(open("statistics.json"))
m = c.get("modules", {})
g = c["gcp"]
out = {
    "PROJECT": g["project"], "NUMBER": g["number"], "REGION": g.get("region", "europe-west1"),
    "ACCOUNT": g["account"], "VIEWERS": ",".join(g.get("viewers") or [g["account"]]),
    "PREFIX": c.get("prefix", "stats"), "DOMAIN": c["domain"], "ADMIN_HOST": c.get("admin_host", ""),
    "TZ_NAME": c.get("timezone", "Europe/Berlin"),
    "SITE_DATASET": c.get("datasets", {}).get("site", "site_analytics"),
    "RANK_DATASET": c.get("datasets", {}).get("rankings", "seo_rankings"),
    "M_VISITORS": int(bool(m.get("visitors"))), "M_GROWTH": int(bool(m.get("growth"))), "M_USERS": int(bool(m.get("users"))),
    "M_APPSTORE": int(bool(m.get("appstore"))), "M_RANKINGS": int(bool(m.get("rankings"))),
    "M_PLAY": int(bool(m.get("googleplay"))), "PLAY_DATASET": c.get("datasets", {}).get("play", "play"),
    "PLAY_BUCKET": c.get("googleplay", {}).get("bucket", ""), "PLAY_SUFFIX": c.get("googleplay", {}).get("table_suffix", "GP"),
    "ACTIVITY": c.get("growth", {}).get("activity", {}).get("source", "none"),
    "REVENUE": c.get("growth", {}).get("revenue", "none"),
    "ASC_KEY_ID": c.get("appstore", {}).get("key_id", ""), "ASC_ISSUER_ID": c.get("appstore", {}).get("issuer_id", ""),
    "ASC_VENDOR": c.get("appstore", {}).get("vendor_number", ""),
    "DFS_PROJECT": c.get("rankings", {}).get("dataforseo_secret_project", ""),
    "GSC_SITE": c.get("rankings", {}).get("gsc_site", f"sc-domain:{c['domain']}"),
}
for k, v in out.items():
    print(f"{k}={shlex.quote(str(v))}")
PY
)"

COPY_DFS=0; ASC_SOURCE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --copy-dataforseo) COPY_DFS=1 ;;
    --copy-asc-key) ASC_SOURCE="$2"; shift ;;
    *) echo "unknown flag $1" >&2; exit 1 ;;
  esac
  shift
done

ADMIN_SA=$PREFIX-admin@$PROJECT.iam.gserviceaccount.com
VISITS_SA=$PREFIX-telemetry@$PROJECT.iam.gserviceaccount.com
APPSTORE_SA=$PREFIX-appstore@$PROJECT.iam.gserviceaccount.com
RANK_SA=$PREFIX-ranks@$PROJECT.iam.gserviceaccount.com
SCHED_SA=$PREFIX-scheduler@$PROJECT.iam.gserviceaccount.com
IAP_SA=service-$NUMBER@gcp-sa-iap.iam.gserviceaccount.com
IMAGE=$REGION-docker.pkg.dev/$PROJECT/$PREFIX/statistics:$(date +%Y%m%d%H%M%S)
export CLOUDSDK_CORE_ACCOUNT=$ACCOUNT  # bq has no --account flag and would use the active one
g() { gcloud --project "$PROJECT" --account "$ACCOUNT" "$@"; }

g services enable bigquery.googleapis.com run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com \
  iap.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com cloudresourcemanager.googleapis.com \
  $([[ $M_RANKINGS == 1 ]] && echo searchconsole.googleapis.com) \
  $([[ $M_PLAY == 1 ]] && echo bigquerydatatransfer.googleapis.com) \
  $([[ $M_USERS == 1 || $ACTIVITY == firestore_days ]] && echo identitytoolkit.googleapis.com firestore.googleapis.com)
gcloud beta services identity create --service=iap.googleapis.com --project "$PROJECT" --account "$ACCOUNT" >/dev/null

for sa in admin telemetry appstore ranks scheduler; do
  g iam service-accounts describe "$PREFIX-$sa@$PROJECT.iam.gserviceaccount.com" >/dev/null 2>&1 || g iam service-accounts create "$PREFIX-$sa"
done
g artifacts repositories describe "$PREFIX" --location "$REGION" >/dev/null 2>&1 ||
  g artifacts repositories create "$PREFIX" --location "$REGION" --repository-format docker

# Gives accounts a role on a dataset (dataset ACLs, so nobody needs project-wide BigQuery rights).
grant_dataset() {  # dataset, then pairs of account role
  local ds=$1; shift
  local tmp; tmp=$(mktemp)
  bq --project_id="$PROJECT" show --format=prettyjson "$PROJECT:$ds" > "$tmp"
  python3 - "$tmp" "$@" <<'PY'
import json, sys
path, *pairs = sys.argv[1:]
ds = json.load(open(path))
for email, role in zip(pairs[::2], pairs[1::2]):
    if not any(a.get("userByEmail") == email for a in ds["access"]):
        ds["access"].append({"role": role, "userByEmail": email})
json.dump(ds, open(path, "w"))
PY
  bq --project_id="$PROJECT" update --source "$tmp" "$PROJECT:$ds" >/dev/null
  rm -f "$tmp"
}
for sa in "$ADMIN_SA" "$APPSTORE_SA" "$RANK_SA"; do
  g projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$sa" --role roles/bigquery.jobUser --condition=None >/dev/null
done

if [[ $M_VISITORS == 1 || $M_APPSTORE == 1 ]]; then
  bq --project_id="$PROJECT" show "$PROJECT:$SITE_DATASET" >/dev/null 2>&1 || bq --project_id="$PROJECT" mk --location=EU --dataset "$PROJECT:$SITE_DATASET"
  # Visits are kept 24 months, then dropped (partition expiry).
  bq --project_id="$PROJECT" show "$PROJECT:$SITE_DATASET.site_traffic" >/dev/null 2>&1 ||
    bq --project_id="$PROJECT" mk --table --time_partitioning_field ts --time_partitioning_type DAY --time_partitioning_expiration 63072000 \
      "$PROJECT:$SITE_DATASET.site_traffic" telemetry/schema.json
  grant_dataset "$SITE_DATASET" "$VISITS_SA" WRITER "$APPSTORE_SA" WRITER "$ADMIN_SA" READER
fi
if [[ $M_RANKINGS == 1 ]]; then
  bq --project_id="$PROJECT" show "$PROJECT:$RANK_DATASET" >/dev/null 2>&1 || bq --project_id="$PROJECT" mk --location=EU --dataset "$PROJECT:$RANK_DATASET"
  grant_dataset "$RANK_DATASET" "$RANK_SA" WRITER "$ADMIN_SA" READER
fi

if [[ $M_PLAY == 1 ]]; then
  # BigQuery's Google Play transfer writes here; the admin page only reads.
  bq --project_id="$PROJECT" show "$PROJECT:$PLAY_DATASET" >/dev/null 2>&1 || bq --project_id="$PROJECT" mk --location=EU --dataset "$PROJECT:$PLAY_DATASET"
  grant_dataset "$PLAY_DATASET" "$ADMIN_SA" READER
  if bq --project_id="$PROJECT" ls --transfer_config --transfer_location=eu --format=json 2>/dev/null | grep -q '"dataSourceId": *"play"'; then
    :
  elif [[ -n $PLAY_BUCKET ]]; then
    # Interactive: bq prints a Google sign-in URL and waits for the code, so it is not run from here.
    echo "Google Play: create the transfer once, as a Play Console user with access to reports:" >&2
    echo "  bq mk --transfer_config --project_id $PROJECT --target_dataset $PLAY_DATASET --data_source play \\" >&2
    echo "    --display_name 'Google Play reports' --params '{\"bucket\":\"$PLAY_BUCKET\",\"table_suffix\":\"$PLAY_SUFFIX\"}'" >&2
  else
    echo "Google Play: no googleplay.bucket in statistics.json yet; the tab says 'No Play data yet' (manual-steps.md)." >&2
  fi
fi

secret() {  # name, account that may read it
  g secrets describe "$1" >/dev/null 2>&1 || g secrets create "$1" --replication-policy automatic
  g secrets add-iam-policy-binding "$1" --member "serviceAccount:$2" --role roles/secretmanager.secretAccessor --condition=None >/dev/null
}
if [[ $M_VISITORS == 1 ]]; then
  g secrets describe VISITOR_SALT >/dev/null 2>&1 || openssl rand -hex 32 | g secrets create VISITOR_SALT --data-file=- --replication-policy=automatic
  secret VISITOR_SALT "$VISITS_SA"
fi
if [[ $M_APPSTORE == 1 ]]; then
  secret ASC_KEY "$APPSTORE_SA"
  if [[ -n $ASC_SOURCE ]]; then  # piped, so the key is never printed or written to disk
    gcloud secrets versions access latest --secret "${ASC_SOURCE#*:}" --project "${ASC_SOURCE%%:*}" --account "$ACCOUNT" |
      g secrets versions add ASC_KEY --data-file=- >/dev/null
  fi
fi
if [[ $M_RANKINGS == 1 ]]; then
  for s in DATAFORSEO_LOGIN DATAFORSEO_PASSWORD; do
    secret "$s" "$RANK_SA"
    if [[ $COPY_DFS == 1 ]]; then
      gcloud secrets versions access latest --secret "$s" --project "$DFS_PROJECT" --account "$ACCOUNT" | g secrets versions add "$s" --data-file=- >/dev/null
    fi
  done
fi
STRIPE_FLAGS=()
if [[ $M_GROWTH == 1 && $REVENUE == stripe ]]; then
  secret STRIPE_SECRET_KEY "$ADMIN_SA"   # add a restricted read-only key by hand: charges + balance transactions
  if g secrets versions list STRIPE_SECRET_KEY --limit 1 --format='value(name)' | grep -q .; then
    STRIPE_FLAGS=(--set-secrets STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest)
  else
    echo "STRIPE_SECRET_KEY has no version yet: Growth shows no revenue until one is added." >&2
  fi
fi
if [[ $M_USERS == 1 ]]; then
  g projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$ADMIN_SA" --role roles/firebaseauth.viewer --condition=None >/dev/null
fi
if [[ $M_GROWTH == 1 && $ACTIVITY == firestore_days ]]; then
  g projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$ADMIN_SA" --role roles/datastore.viewer --condition=None >/dev/null
fi

uv run --with-requirements requirements-dev.txt pytest -q
g builds submit --tag "$IMAGE" .

schedule() {  # job, cron
  g run jobs add-iam-policy-binding "$1" --region "$REGION" --member "serviceAccount:$SCHED_SA" --role roles/run.invoker >/dev/null
  g scheduler jobs describe "$1-schedule" --location "$REGION" >/dev/null 2>&1 ||
    g scheduler jobs create http "$1-schedule" --location "$REGION" --schedule "$2" --time-zone "$TZ_NAME" \
      --uri "https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$1:run" \
      --http-method POST --oauth-service-account-email "$SCHED_SA" --oauth-token-scope https://www.googleapis.com/auth/cloud-platform
}

if [[ $M_VISITORS == 1 ]]; then
  # The public collector the site's beacon posts to.
  g run deploy "$PREFIX-telemetry" --region "$REGION" --image "$IMAGE" --service-account "$VISITS_SA" --allow-unauthenticated \
    --command gunicorn --args=--bind,:8080,--workers,1,--threads,4,telemetry.app:app --max-instances 2 --memory 256Mi \
    --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT" --set-secrets VISITOR_SALT=VISITOR_SALT:latest
  echo "Beacon endpoint: $(g run services describe "$PREFIX-telemetry" --region "$REGION" --format='value(status.url)')/visit"
fi
if [[ $M_APPSTORE == 1 ]]; then
  g run jobs deploy "$PREFIX-appstore" --region "$REGION" --image "$IMAGE" --service-account "$APPSTORE_SA" \
    --command python --args=-m,appstore.main --max-retries 1 --task-timeout 1800s --memory 512Mi \
    --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT,ASC_KEY_ID=$ASC_KEY_ID,ASC_ISSUER_ID=$ASC_ISSUER_ID,ASC_VENDOR_NUMBER=$ASC_VENDOR" \
    --set-secrets ASC_KEY=ASC_KEY:latest
  schedule "$PREFIX-appstore" '0 9 * * *'
fi
if [[ $M_RANKINGS == 1 ]]; then
  g run jobs deploy "$PREFIX-ranks" --region "$REGION" --image "$IMAGE" --service-account "$RANK_SA" \
    --command python --args=-m,rank_tracker.main --max-retries 0 --task-timeout 14400s --memory 512Mi \
    --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT,BQ_DATASET=$RANK_DATASET,GSC_SITE=$GSC_SITE" \
    --set-secrets DATAFORSEO_LOGIN=DATAFORSEO_LOGIN:latest,DATAFORSEO_PASSWORD=DATAFORSEO_PASSWORD:latest
  schedule "$PREFIX-ranks" '0 6 * * 1'
fi

# The private page. Only IAP may call the service, IAP lets only the viewers through, and the app checks again.
g run deploy "$PREFIX-admin" --region "$REGION" --image "$IMAGE" --service-account "$ADMIN_SA" \
  --no-allow-unauthenticated --iap --max-instances 1 --memory 512Mi ${STRIPE_FLAGS[@]+"${STRIPE_FLAGS[@]}"} \
  --set-env-vars "^|^GOOGLE_CLOUD_PROJECT=$PROJECT|ALLOWED_EMAILS=$VIEWERS|IAP_AUDIENCE=/projects/$NUMBER/locations/$REGION/services/$PREFIX-admin"
g run services add-iam-policy-binding "$PREFIX-admin" --region "$REGION" --member "serviceAccount:$IAP_SA" --role roles/run.invoker --condition=None >/dev/null
for v in ${VIEWERS//,/ }; do
  gcloud iap web add-iam-policy-binding --project "$PROJECT" --account "$ACCOUNT" --resource-type=cloud-run --service="$PREFIX-admin" \
    --region="$REGION" --member "user:$v" --role roles/iap.httpsResourceAccessor --condition=None >/dev/null
done
if [[ "${MAP_DOMAINS:-}" == 1 && -n $ADMIN_HOST ]]; then
  g beta run domain-mappings describe --domain "$ADMIN_HOST" --region "$REGION" >/dev/null 2>&1 ||
    g beta run domain-mappings create --service "$PREFIX-admin" --domain "$ADMIN_HOST" --region "$REGION"
fi
g run services describe "$PREFIX-admin" --region "$REGION" --format='value(status.url)'
