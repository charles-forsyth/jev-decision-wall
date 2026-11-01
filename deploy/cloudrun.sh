#!/usr/bin/env bash
# Deploy to Google Cloud Run behind Identity-Aware Proxy (Google sign-in), limited to one Workspace domain.
#
#   PROJECT=my-gcp-project DOMAIN=example.edu ./deploy/cloudrun.sh
#
# Needs: gcloud (logged in as a project owner/editor), APIs run, iap, cloudbuild, secretmanager.
# Your key is read from TYPESAFE_API_KEY (or .env) once, stored in Secret Manager, never in the image.
# Every action is logged as structured JSON to Cloud Logging (jsonPayload.component="jev-decision-wall").
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PROJECT:?set PROJECT=<gcp project id>}"
: "${DOMAIN:?set DOMAIN=<your workspace domain, e.g. example.edu>}"
REGION=${REGION:-us-central1}
SVC=${SVC:-jev-decision-wall}
SECRET=${SVC}-key
SA=${SVC}@${PROJECT}.iam.gserviceaccount.com
NUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
IAP_AGENT=service-${NUM}@gcp-sa-iap.iam.gserviceaccount.com
REPO=${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy
TAG=$(git rev-parse --short=12 HEAD 2>/dev/null || date +%s)

[ -f .env ] && set -a && . ./.env && set +a
gcloud services enable run.googleapis.com iap.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com --project "$PROJECT"

echo "== service account (no project roles) + secret"
gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SVC" --project "$PROJECT" --display-name "Jev Decision Wall"
if ! gcloud secrets describe "$SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  : "${TYPESAFE_API_KEY:?set TYPESAFE_API_KEY (or put it in .env) for the first deploy}"
  gcloud secrets create "$SECRET" --project "$PROJECT" --replication-policy automatic
  printf %s "$TYPESAFE_API_KEY" | gcloud secrets versions add "$SECRET" --project "$PROJECT" --data-file=- >/dev/null
fi
gcloud secrets add-iam-policy-binding "$SECRET" --project "$PROJECT" --member "serviceAccount:${SA}" --role roles/secretmanager.secretAccessor >/dev/null

echo "== build"
gcloud builds submit --project "$PROJECT" --region "$REGION" --tag "${REPO}/${SVC}:${TAG}" .

echo "== deploy (IAP on, max 1 instance so per-user caps stay in one process)"
gcloud run deploy "$SVC" --project "$PROJECT" --region "$REGION" --quiet \
  --image "${REPO}/${SVC}:${TAG}" --service-account "$SA" \
  --iap --no-allow-unauthenticated --ingress all \
  --min-instances 0 --max-instances 1 --cpu 1 --memory 256Mi --timeout 60 \
  --set-env-vars "AUTH_HEADER=x-goog-authenticated-user-email,ALLOWED_DOMAIN=${DOMAIN},JEV_DAILY_TOKEN_CAP=${JEV_DAILY_TOKEN_CAP:-5000000},JEV_USER_DAILY_TOKEN_CAP=${JEV_USER_DAILY_TOKEN_CAP:-1000000}" \
  --set-secrets "TYPESAFE_API_KEY=${SECRET}:latest"

echo "== IAM: IAP agent invokes; everyone @${DOMAIN} may sign in"
gcloud run services add-iam-policy-binding "$SVC" --project "$PROJECT" --region "$REGION" --member "serviceAccount:${IAP_AGENT}" --role roles/run.invoker >/dev/null
gcloud iap web add-iam-policy-binding --project "$PROJECT" --resource-type=cloud-run --service="$SVC" --region="$REGION" \
  --member="domain:${DOMAIN}" --role=roles/iap.httpsResourceAccessor >/dev/null
if gcloud run services get-iam-policy "$SVC" --project "$PROJECT" --region "$REGION" --format=json | grep -q '"allUsers"\|"allAuthenticatedUsers"'; then
  echo "FAIL: public invoker present"; exit 1; fi
echo "== live: $(gcloud run services describe "$SVC" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
echo "   (a new IAP grant can take ~3 minutes before the first sign-in works)"
