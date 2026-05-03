#!/bin/bash
# Tear down the smoke Lambda + IAM role. Run after the test is done.
set -e

ROLE_NAME="bn-smoke-lambda-role"
FN_NAME="bn-smoke-predict"
REGION="${AWS_REGION:-us-east-1}"

aws lambda delete-function --function-name "$FN_NAME" --region "$REGION" 2>/dev/null || true
aws iam detach-role-policy \
	--role-name "$ROLE_NAME" \
	--policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole 2>/dev/null || true
aws iam delete-role --role-name "$ROLE_NAME" 2>/dev/null || true

echo "[teardown] $FN_NAME removed from $REGION."
