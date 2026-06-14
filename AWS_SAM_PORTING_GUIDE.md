# AWS SAM Porting Guide for MyGala Backend Services

This guide documents the exact pattern used to migrate `bk-general` from Serverless Framework to AWS SAM, including every issue hit and how it was resolved, so future service ports go smoothly.

---

## 1. What Was Migrated in bk-general

- Deployment definition moved from `serverless.yml` to `template.yaml`.
- Lambda runtime upgraded from `nodejs16.x` to `nodejs22.x`.
- GitHub Actions deployment trigger moved to the shared reusable workflow in `mygala-in/gh-workflows`.
- SAM parameter files added for CI (keys must match `template.yaml` parameter names exactly):
  - `bk-config/configs.<stage>.txt`
  - `bk-config/configs.<stage>.json` (source of truth)
  - `bk-config/envs.<stage>.txt`
  - `bk-config/envs.<stage>.json` (source of truth)
- `Makefile` added to handle nested `bk-utils` dependency installation during SAM build.
- `bk-utils` fully migrated from AWS SDK v2 (`aws-sdk`) to AWS SDK v3 (`@aws-sdk/client-*`).
- `bk-utils` dependency `googleapis` (122 MB) replaced with `@googleapis/sheets` (~3 MB).
- Lambda runs **outside any VPC** — no NAT gateway needed, RDS made publicly accessible.
- API path parsing hardened to support both:
  - custom domain base-path URLs (e.g. `/general/v1/...`)
  - direct execute-api URLs (e.g. `/prod/v1/...`)

---

## 2. Prerequisites

```bash
node -v       # must be 22+
npm -v
sam --version
aws --version
```

AWS auth must be configured for the target account:

```bash
export AWS_PROFILE=mygala-prod   # or mygala-dev
aws sts get-caller-identity      # verify
```

---

## 3. Template Design Pattern

### 3.1 Parameters

Declare one `Parameters` block covering all stage-dependent values from the JSON config files. Avoid hardcoding secrets — they come from `bk-config/envs.<stage>.txt` at deploy time.

Minimal required parameters for every service:

```yaml
Parameters:
  Stage:
    Type: String
    AllowedValues: [dev, prod]
  EnvPrefix:
    Type: String
  LambdaRoleArn:
    Type: String
  AwsRegion:
    Type: String
  AwsAccountId:
    Type: String
```

Add additional parameters for every environment variable the Lambda needs.

### 3.2 Globals

Use `Globals.Function` for shared runtime config:

```yaml
Globals:
  Function:
    Runtime: nodejs22.x
    Timeout: 12
    CodeUri: .
    Environment:
      Variables:
        stage: !Ref Stage
        awsRegion: !Ref AwsRegion
        # ... all other env vars
```

Do **not** add `VpcConfig` here — Lambda runs outside VPC (see section 9).

### 3.3 API and Events

Create one `AWS::Serverless::Api` and attach each function's HTTP events to it via `RestApiId`:

```yaml
Resources:
  MyApi:
    Type: AWS::Serverless::Api
    Properties:
      Name: !Sub '${EnvPrefix}-myservice-api'
      StageName: !Ref Stage
      EndpointConfiguration: REGIONAL
      Cors:
        AllowOrigin: "'*'"
        AllowHeaders: "'platform,appversion,Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent,X-Firebase-AppCheck'"
        AllowMethods: "'GET,POST,PUT,OPTIONS'"

  MyFunction:
    Type: AWS::Serverless::Function
    Metadata:
      BuildMethod: makefile          # REQUIRED — see section 4
    Properties:
      FunctionName: !Sub '${EnvPrefix}-myservice-handler'
      Handler: handler.invoke
      Role: !Ref LambdaRoleArn
      Events:
        GetConfig:
          Type: Api
          Properties:
            RestApiId: !Ref MyApi
            Path: /v1/config
            Method: get
```

### 3.4 No VPC Configuration

Lambda functions for `bk-*` services do **not** need VPC config. RDS is publicly accessible (see section 9). Removing VPC eliminates NAT gateway costs and simplifies the template.

If you see VPC parameters or `IsProd` conditions left over from a previous SAM draft, delete them.

---

## 4. Makefile Build Pattern (Critical)

SAM's default Node.js build runs `npm install` only for the root `package.json`, then excludes all `node_modules` directories from nested folders. Because `bk-utils` is a submodule with its own `package.json`, its `node_modules` would be missing at runtime — causing `Cannot find module 'loglevel'` and similar errors.

Fix: use `BuildMethod: makefile` on every function and include a `Makefile` at the repo root.

**Every function** in `template.yaml` needs this under `Properties`:

```yaml
Metadata:
  BuildMethod: makefile
```

The `Makefile` at the repo root:

```makefile
.PHONY: build-FunctionLogicalId   # repeat for every function logical ID

build-FunctionLogicalId:
	rsync -av --exclude='.aws-sam' --exclude='node_modules' --exclude='.git' --exclude='*.log' . $(ARTIFACTS_DIR)/
	cd $(ARTIFACTS_DIR) && npm install --production
	cd $(ARTIFACTS_DIR)/bk-utils && npm install --production
```

> **Tab warning**: Makefiles require a real tab character at the start of each recipe line, not spaces. Copy the `Makefile` from `bk-general` directly rather than pasting from rendered markdown — rendered views silently convert tabs to spaces, which produces `Makefile:3: *** missing separator. Stop.`

For `bk-general` specifically:

```makefile
.PHONY: build-ConfigFunction build-SearchFunction build-EnquiryFunction

build-ConfigFunction build-SearchFunction build-EnquiryFunction:
	rsync -av --exclude='.aws-sam' --exclude='node_modules' --exclude='.git' --exclude='*.log' . $(ARTIFACTS_DIR)/
	cd $(ARTIFACTS_DIR) && npm install --production
	cd $(ARTIFACTS_DIR)/bk-utils && npm install --production
```

Why this works: Node.js module resolution walks up the directory tree. When `bk-utils/logger.js` calls `require('loglevel')`, Node finds `/var/task/bk-utils/node_modules/loglevel` installed by the second `npm install`.

The Makefile target name must be `build-<FunctionLogicalId>` where `FunctionLogicalId` is the exact key used in `Resources:` in `template.yaml`.

---

## 5. AWS SDK v3 Migration (bk-utils)

AWS SDK v2 (`aws-sdk`) is NOT available in the Node.js 18+ Lambda runtime. AWS SDK v3 (`@aws-sdk/client-*`) **is** built into the Node.js 22 runtime — do not bundle it; exclude it from `package.json` dependencies.

### Packages removed from bk-utils

| Removed | Size | Replaced with |
|---|---|---|
| `aws-sdk` | ~100 MB | `@aws-sdk/client-*` (runtime-provided) |
| `googleapis` | ~122 MB | `@googleapis/sheets` (~3 MB) |

This brought the total Lambda unzipped size from ~371 MB (over the 250 MB limit) down to ~152 MB.

### SDK v3 pattern per helper

**SNS** (`sns.helper.js`):
```js
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const sns = new SNSClient({ region: process.env.awsRegion });
// sns.send(new PublishCommand(params))
```

**S3** (`s3.helper.js`):
```js
const { S3Client, GetObjectCommand, PutObjectCommand, ... } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const s3 = new S3Client({ region: process.env.awsRegion });
// s3.send(new GetObjectCommand(params))
// getSignedUrl(s3, new PutObjectCommand(params), { expiresIn: 600 })
// body: await data.Body.transformToByteArray()   ← v3 returns web stream, not Buffer
```

**CloudFront** (`cloudfront.helper.js`):
```js
const { CloudFrontClient, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');
const cf = new CloudFrontClient({ region: process.env.awsRegion });
```

**Step Functions** (`statemachine.helper.js`):
```js
const { SFNClient, StartExecutionCommand, StopExecutionCommand } = require('@aws-sdk/client-sfn');
const sf = new SFNClient({ region: process.env.awsRegion });
```

**Google Sheets** (`googlesheets.helper.js`):
```js
// was: const { google } = require('googleapis');
const { google } = require('@googleapis/sheets');
// rest of the code is unchanged — google.auth.GoogleAuth, google.sheets('v4') still work
```

### ESLint adjustment for runtime-provided packages

`eslint-plugin-import` will flag `import/no-unresolved` on `@aws-sdk/*` packages because they're not in local `node_modules`. Add this to `bk-utils/.eslintrc.json`:

```json
"import/no-unresolved": ["error", { "ignore": ["^@aws-sdk/", "^@googleapis/"] }]
```

Also add `// eslint-disable-next-line import/no-extraneous-dependencies` above each `require('@aws-sdk/...')` line.

---

## 6. GitHub Actions Workflow Pattern

### Caller workflow (in each repo)

```yaml
# .github/workflows/aws-sam-deployer.yml
name: AWS SAM Deploy

on:
  push:
    branches: [main, master]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  deploy:
    if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/master'
    uses: mygala-in/gh-workflows/.github/workflows/aws-sam-deployer.yml@main
    with:
      repo-name: ${{ github.event.repository.name }}
    secrets: inherit
```

### Reusable workflow in gh-workflows

The shared workflow (`aws-sam-deployer.yml` in `gh-workflows` repo):
- Checks out code including submodules using a PAT token
- Runs `npm i` at root AND `cd bk-utils; npm i; cd ..` for linting
- Runs `sam validate --lint`
- Runs ESLint on `bk-utils`
- Runs `sam build`
- Reads `bk-config/configs.<stage>.txt` + `bk-config/envs.<stage>.txt` and concatenates them as `--parameter-overrides`
- Runs `sam deploy` with the stack name `mygala-<repo-name>-<stage>`

### Parameter file format

Each `.txt` file is `Key=Value`, one per line. Keys must exactly match the parameter names in `template.yaml`:

```
# configs.prod.txt
Stage=prod
EnvPrefix=prod_mg
LambdaRoleArn=arn:aws:iam::752855547791:role/mg-bknd-serverless

# envs.prod.txt
AwsRegion=ap-south-1
RdsHost=prod-mygala-rds1-new.cpmzcndw8eco.ap-south-1.rds.amazonaws.com
...
```

### S3 deployment buckets (must exist before first deploy)

The reusable workflow passes a fixed S3 bucket to `sam deploy`:

- dev: `dev-mygala-serverless-deployments`
- prod: `prod-mygala-serverless-deployments`

These buckets must already exist in the target account. If they don't, the deploy step will fail with `NoSuchBucket`. Create them once per account:

```bash
aws s3 mb s3://dev-mygala-serverless-deployments --region ap-south-1 --profile mygala-dev
aws s3 mb s3://prod-mygala-serverless-deployments --region ap-south-1 --profile mygala-prod
```

### PAT token requirement

The reusable workflow checks out private submodules using a hardcoded token in `gh-workflows/aws-sam-deployer.yml`. If checkout fails with `terminal prompts disabled`, the token has expired. Replace it with a new PAT or OAuth token that has `repo` scope.

---

## 7. Custom Domain Base Path Mapping

API Gateway custom domain mapping (`api.mygala.in/general → REST API`) is managed **outside** the SAM stack. Steps to set it up after a new stack is deployed:

```bash
# 1. Get the new REST API ID from the stack output
aws cloudformation describe-stacks --stack-name mygala-bk-general-prod \
  --query 'Stacks[0].Outputs'

# 2. If old mapping exists, delete it first
aws apigateway delete-base-path-mapping \
  --domain-name api.mygala.in \
  --base-path general

# 3. Create new mapping pointing to the new API ID and stage
aws apigateway create-base-path-mapping \
  --domain-name api.mygala.in \
  --base-path general \
  --rest-api-id <new-api-id> \
  --stage prod
```

If you skip the delete step before destroying and recreating the stack, the old REST API will refuse to be deleted:
> `Deleting RestApi failed. Please remove all base path mappings related to the RestApi in your domains.`

---

## 8. Issues Encountered and Fixes

### 8.1 `AWS::EarlyValidation::ResourceExistenceCheck` on first deploy

**Error**: SAM changeset creation failed with `ResourceExistenceCheck`.

**Cause**: The old Serverless Framework stack had Lambda functions with logical IDs like `ConfigLambdaFunction`. The SAM template uses `ConfigFunction`. Both tried to manage the same physical Lambda function name — CloudFormation saw a conflict.

**Fix**: Delete the old Serverless stack entirely before deploying the SAM stack.

```bash
aws cloudformation delete-stack --stack-name mygala-bk-general-prod
aws cloudformation wait stack-delete-complete --stack-name mygala-bk-general-prod
```

### 8.2 Stack deletion blocked by custom domain mapping

**Error**: `Deleting RestApi failed. Please remove all base path mappings related to the RestApi in your domains: api.mygala.in`

**Fix**: Remove the base path mapping before deleting the stack (see section 7).

### 8.3 `Cannot find module 'loglevel'` at runtime

**Cause**: SAM's default Node.js build excludes nested `node_modules`. `bk-utils/node_modules` was never included in the Lambda package.

**First attempt (failed)**: Added all bk-utils deps to root `package.json` → hit 250 MB Lambda size limit (371 MB total due to `aws-sdk` + `googleapis`).

**Final fix**: `BuildMethod: makefile` with a Makefile that runs `npm install --production` inside `$(ARTIFACTS_DIR)/bk-utils`. See section 4.

### 8.4 Lambda unzipped size exceeds 250 MB

**Cause**: `aws-sdk` v2 (~100 MB) + `googleapis` (~122 MB) + remaining deps = ~371 MB.

**Fix**: Remove both. See section 5 for the complete SDK v3 migration.

### 8.5 Git detached HEAD — submodule commit not reachable in CI

**Error**: `fatal: remote error: upload-pack: not our ref <sha>`

**Cause**: A commit was made from a detached HEAD state inside `bk-utils`. The SHA was committed to `bk-general`'s submodule reference but was never pushed to the `bk-utils` remote `main` branch.

**Fix**:
```bash
cd bk-utils
git checkout main
git merge <detached-sha>
git push origin main
cd ..
git add bk-utils
git commit -m "Update bk-utils submodule reference"
git push
```

### 8.6 ESLint `Unable to resolve path to module '@aws-sdk/client-sfn'`

**Cause**: `eslint-plugin-import` cannot find `@aws-sdk/*` packages because they are Lambda runtime packages not installed locally.

**Fix**: Added to `bk-utils/.eslintrc.json`:
```json
"import/no-unresolved": ["error", { "ignore": ["^@aws-sdk/", "^@googleapis/"] }]
```

### 8.7 Expired PAT in reusable workflow

**Error**: `could not read Username for 'https://github.com': terminal prompts disabled`

**Fix**: Replace the expired token in `gh-workflows/aws-sam-deployer.yml` with a new one that has `repo` scope.

---

## 9. Infrastructure: Lambda Outside VPC, Public RDS

To avoid NAT gateway costs (~$30/month), Lambda runs outside any VPC and RDS is made publicly accessible.

### What was done

1. Enabled DNS hostnames on the VPC: `aws ec2 modify-vpc-attribute --enable-dns-hostnames`
2. Set `PubliclyAccessible: true` on the RDS instance.
3. Added inbound rule for port 3306 from `0.0.0.0/0` to the RDS security group.
4. Updated the private subnet route table: replaced the dead NAT gateway blackhole with the internet gateway.
5. Migrated RDS to the **default VPC** via snapshot + restore into `default-vpc-*` subnet group.
6. Updated `rdsHost` in `bk-config/envs.prod.txt` and `envs.prod.json`.

### Current prod RDS

- Instance: `prod-mygala-rds1-new`
- VPC: default VPC (`vpc-09a433f330c524600`)
- Subnet group: `default-vpc-09a433f330c524600`
- Security group: `prod-rds-sg` (port 3306 open to `0.0.0.0/0`)
- Endpoint: `prod-mygala-rds1-new.cpmzcndw8eco.ap-south-1.rds.amazonaws.com`

### Template has no VpcConfig

Do not add `VpcConfig` to `Globals.Function` or individual functions. If VPC config is needed again in the future, add subnet/SG parameters back to `template.yaml` and `configs.<stage>.txt`.

---

## 10. API Verification Checklist

After deploying to prod, verify the service is live. Replace `<service>` and `<function-name>` with your service's values throughout.

### Step 1 — Confirm base path mapping

```bash
aws apigateway get-base-path-mappings --domain-name api.mygala.in
# should show your service's basePath, restApiId, and stage=prod
```

### Step 2 — Hit an unauthenticated endpoint

Find a `role: 0` endpoint in `bk-utils/services/<service>.js` — any endpoint with `role: 0` requires no `Authorization` header.

```bash
curl -s https://api.mygala.in/<service>/v1/<public-action>
# expect: valid JSON, not a 401 or 500
```

For `bk-general` specifically: `curl -s https://api.mygala.in/general/v1/config | jq '.appName'`

A valid JSON response confirms Lambda, API Gateway, and downstream connectivity (RDS/Redis) are all working end-to-end.

### Step 3 — JWT-protected endpoints

For endpoints with `role > 0` in the service constants, include the JWT:

```bash
curl -s https://api.mygala.in/<service>/v1/<protected-action> \
  -H "Authorization: <jwt-token>"
```

To check whether a specific endpoint requires auth: look up its path in `bk-utils/services/<service>.js`. If `role: 0` → no token needed. If `role > 0` → `Authorization` header required.

`X-Firebase-AppCheck` is logged as a warning if missing but does **not** block requests.

### Step 4 — Check CloudWatch logs

```bash
# Pattern: /aws/lambda/<envPrefix>-<service>-<handler>
aws logs tail /aws/lambda/prod_mg-<service>-<handler> --follow --profile mygala-prod

# bk-general example:
aws logs tail /aws/lambda/prod_mg-general-config-apis --follow --profile mygala-prod
```

---

## 11. Porting Checklist for Another Service

1. Copy `template.yaml` from `bk-general`. Rename all `General`/`general` references.
2. Map each old Serverless `functions[].events` → SAM `Events` under each function.
3. Set `Runtime: nodejs22.x` in `Globals.Function`.
4. Add `Metadata: BuildMethod: makefile` to every function.
5. Copy the `Makefile` file directly from `bk-general` (do not paste from rendered markdown — tabs will break). Update the `.PHONY` list and target names to match the new function logical IDs.
6. Update the `bk-utils` submodule to the latest `main` commit (which has the SDK v3 migration):
   ```bash
   cd bk-utils
   git checkout main
   git pull origin main
   cd ..
   git add bk-utils
   git commit -m "Update bk-utils to SDK v3 migration"
   git push
   ```
   Verify the submodule points to a pushed commit — CI will fail with `upload-pack: not our ref` if the commit only exists locally.
7. Ensure `bk-utils/.eslintrc.json` has the `@aws-sdk/` ignore rule (already present after SDK v3 migration — just confirm it's there).
8. Create `bk-config/configs.<stage>.txt` and `envs.<stage>.txt` — keys must match `template.yaml` parameters exactly. Commit these to `bk-config` and update the submodule reference in the service repo.
9. **Do not add VPC config** to the template.
10. Delete `serverless.yml` (and `.serverlessignore` if present) from the repo — keeping it risks confusion and stale CI references.
11. Add `.aws-sam/` to `.gitignore` if not already there.
12. Add `.github/workflows/aws-sam-deployer.yml` with the caller workflow from section 6. Note: the workflow only deploys on `main`/`master` pushes — there is no automatic dev deploy. To test CI without affecting prod, temporarily add `aws-sam` to the branch list in the caller workflow, push to that branch, then revert.
13. Run `sam validate --lint` locally before pushing.
14. Verify the S3 deployment buckets exist in the target account (see section 6).
15. Delete old Serverless stack if it exists — remove custom domain base path mapping first (see section 7), then:
    ```bash
    aws cloudformation delete-stack --stack-name mygala-<service>-prod --profile mygala-prod
    aws cloudformation wait stack-delete-complete --stack-name mygala-<service>-prod --profile mygala-prod
    ```
16. Push to `main` → verify CI passes → check CloudWatch logs.
17. Re-create the custom domain base path mapping after the new stack is deployed (see section 7).
18. Smoke-test an unauthenticated endpoint to confirm Lambda, RDS, and Redis are all reachable (see section 10).

---

## 12. Secrets and Config File Locations

| File | Used by | Contains |
|---|---|---|
| `bk-config/configs.<stage>.json` | humans / local tooling | infra config (VPC, roles, prefixes) |
| `bk-config/configs.<stage>.txt` | CI (sam deploy) | same values, key=value format |
| `bk-config/envs.<stage>.json` | humans / local tooling | runtime secrets (DB creds, API keys) |
| `bk-config/envs.<stage>.txt` | CI (sam deploy) | same values, key=value format |

Keep `.json` and `.txt` files in sync manually. The `.txt` files are the source for `--parameter-overrides` in CI.

Long-term: migrate secrets to SSM Parameter Store or Secrets Manager to avoid secrets in plaintext config files.

---

## 13. Post-Migration VPC Cleanup

Run this section **only after all 14 services have been ported to SAM and no Lambda function has VPC config anymore.** Verify with:

```bash
aws lambda list-functions --profile mygala-prod \
  --query 'Functions[?VpcConfig.VpcId==`vpc-08a1c96f4db98e31a`].FunctionName' \
  --output text
# must return empty before proceeding
```

### 13.1 Services that need migrating (custom VPC blockers)

All functions below are on `nodejs16.x` with VPC config — each needs a full SAM port:

| Service repo | Lambda functions |
|---|---|
| bk-occasion | occasion-apis, occasion-event-apis, occasion-bg-tasks, occasion-rsvp-apis |
| bk-vendor | vendor-apis, vendor-bg-tasks, vendor-package-apis |
| bk-chat | chat-apis, chat-bg-tasks, chat-recent-msg |
| bk-asset | asset-apis, asset-bg-tasks, asset-s3 |
| bk-post | post-apis, post-bg-tasks |
| bk-notification | notification-apis, notification-bg-tasks, notification-fcm |
| bk-payment | payment-apis, payment-notification-apis |
| bk-profile | profile-apis |
| bk-admin | admin-apis |
| bk-lead | lead-config-apis |
| bk-location | location-apis |
| bk-gifting | gifting-config-apis |
| bk-watchman | watchman-job |
| bk-discord | discord-sns-notifier, error-discord-notifier |

### 13.2 Replace ElastiCache with Upstash

ElastiCache Serverless (`prod-mygala`, Valkey) lives in the custom VPC and must be replaced before the VPC can be deleted. `redis.helper.js` in `bk-utils` already has `tls: {}` so no code changes are needed — only config.

1. Create a free Redis database at [upstash.com](https://upstash.com) (free tier: 256 MB, TLS enabled).
2. Get the endpoint, port, and password from the Upstash console.
3. Update `bk-config/envs.prod.json` and `envs.prod.txt`:
   ```
   RedisHost=<upstash-endpoint>.upstash.io
   RedisPort=6379
   RedisPassword=<upstash-password>
   ```
4. Redeploy all services to pick up the new Redis connection.
5. Smoke-test caching (a cache miss is fine; a connection error is not).
6. Delete the ElastiCache serverless cluster:
   ```bash
   aws elasticache delete-serverless-cache \
     --serverless-cache-name prod-mygala \
     --profile mygala-prod
   ```

### 13.3 Delete VPC resources in order

Delete in this exact order — later steps depend on earlier ones completing.

```bash
PROFILE=mygala-prod
VPC=vpc-08a1c96f4db98e31a

# 1. NAT Gateway (~$30/month saved — biggest win)
aws ec2 delete-nat-gateway --nat-gateway-id nat-0edcc6402aa028472 --profile $PROFILE
# wait for it to reach 'deleted' state before continuing
aws ec2 wait nat-gateway-deleted --nat-gateway-ids nat-0edcc6402aa028472 --profile $PROFILE 2>/dev/null || \
  aws ec2 describe-nat-gateways --nat-gateway-ids nat-0edcc6402aa028472 --profile $PROFILE \
    --query 'NatGateways[0].State' --output text

# 2. VPC Endpoints (ElastiCache serverless)
aws ec2 delete-vpc-endpoints \
  --vpc-endpoint-ids vpce-0da7f4711acec2961 vpce-0ee167c9242712552 vpce-03a3b1a6f54bb4504 \
  --profile $PROFILE

# 3. ElastiCache subnet group
aws elasticache delete-cache-subnet-group \
  --cache-subnet-group-name prod-mygala-redis \
  --profile $PROFILE

# 4. RDS DB subnet groups
aws rds delete-db-subnet-group --db-subnet-group-name prod-mg-rds-subnetgroup --profile $PROFILE
aws rds delete-db-subnet-group --db-subnet-group-name prod-mg-rds-public-subnetgroup --profile $PROFILE

# 5. Security groups (delete in any order; default SG deletes with the VPC)
for SG in sg-0e01daac2039691bf sg-09a003a856cf4e054 sg-0f3522b0f72ed3d09 \
           sg-0e07600d81c402293 sg-0e926d6e96b1f5522 sg-006cfe3469fc1490c; do
  aws ec2 delete-security-group --group-id $SG --profile $PROFILE 2>&1
done

# 6. Subnets
for SUBNET in subnet-05a83a6dfe7b334aa subnet-08c51338951209fbc subnet-05a7a1e8384746cdb \
              subnet-0b63563c9430aa22e subnet-03e9b972b6ae6be22; do
  aws ec2 delete-subnet --subnet-id $SUBNET --profile $PROFILE 2>&1
done

# 7. Route tables (non-main only — main route table deletes with VPC)
aws ec2 delete-route-table --route-table-id rtb-04be24d277bf6ed69 --profile $PROFILE
aws ec2 delete-route-table --route-table-id rtb-0d2b7a5f24658c797 --profile $PROFILE

# 8. Detach and delete internet gateway
aws ec2 detach-internet-gateway --internet-gateway-id igw-056c2dcfd6b2e7dad --vpc-id $VPC --profile $PROFILE
aws ec2 delete-internet-gateway --internet-gateway-id igw-056c2dcfd6b2e7dad --profile $PROFILE

# 9. Delete VPC (last)
aws ec2 delete-vpc --vpc-id $VPC --profile $PROFILE
```

### 13.4 Verify cleanup

```bash
# Should return nothing
aws ec2 describe-vpcs --vpc-ids vpc-08a1c96f4db98e31a --profile mygala-prod 2>&1
# Expected: "InvalidVpcID.NotFound"

# Confirm no NAT gateway charges remain
aws ec2 describe-nat-gateways --profile mygala-prod \
  --filter "Name=state,Values=available" \
  --query 'NatGateways[*].{Id:NatGatewayId,VPC:VpcId}' --output table
```
