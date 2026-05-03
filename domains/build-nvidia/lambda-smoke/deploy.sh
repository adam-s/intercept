#!/bin/bash
# Deploy / update the build-nvidia smoke Lambda. Idempotent.
# Mirrors toolkit/experiments/poc-lambda-fanout/deploy.sh.
set -e

cd "$(dirname "$0")"

ROLE_NAME="bn-smoke-lambda-role"
FN_NAME="bn-smoke-predict"
REGION="${AWS_REGION:-us-east-1}"

echo "[deploy] zipping Lambda..."
( cd lambda && zip -q ../function.zip index.mjs )

if ! aws iam get-role --role-name "$ROLE_NAME" --region "$REGION" >/dev/null 2>&1; then
	echo "[deploy] creating IAM role $ROLE_NAME..."
	aws iam create-role \
		--role-name "$ROLE_NAME" \
		--assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
		>/dev/null
	aws iam attach-role-policy \
		--role-name "$ROLE_NAME" \
		--policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole \
		>/dev/null
	echo "[deploy] waiting 12s for IAM role propagation..."
	sleep 12
fi

ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)

if aws lambda get-function --function-name "$FN_NAME" --region "$REGION" >/dev/null 2>&1; then
	echo "[deploy] updating existing function $FN_NAME..."
	aws lambda update-function-code \
		--function-name "$FN_NAME" \
		--zip-file fileb://function.zip \
		--region "$REGION" \
		>/dev/null
	aws lambda wait function-updated --function-name "$FN_NAME" --region "$REGION"
else
	echo "[deploy] creating function $FN_NAME..."
	aws lambda create-function \
		--function-name "$FN_NAME" \
		--runtime nodejs20.x \
		--role "$ROLE_ARN" \
		--handler index.handler \
		--zip-file fileb://function.zip \
		--timeout 30 \
		--memory-size 256 \
		--region "$REGION" \
		>/dev/null
	aws lambda wait function-active --function-name "$FN_NAME" --region "$REGION"
fi

echo "[deploy] Lambda $FN_NAME ready in $REGION."
