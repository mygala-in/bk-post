# Configuration Files (Example)

This directory shows example configuration files for the `bk-config` submodule.

**Note:** The actual `bk-config` directory is a Git submodule pointing to a private repository. These examples are provided to help external users understand the configuration structure.

## Required Files for Deployment

### 1. `configs.{stage}.json`

Create configuration files for each deployment stage (e.g., `configs.dev.json`, `configs.prod.json`):

```json
{
  "envPrefix": "your-environment-prefix",
  "awsRegion": "ap-south-1",
  "awsAccountId": "YOUR_AWS_ACCOUNT_ID",
  "securityGroup": "sg-xxxxxxxxxxxxxxxxx",
  "subnet1": "subnet-xxxxxxxxxxxxxxxxx",
  "subnet2": "subnet-xxxxxxxxxxxxxxxxx",
  "subnet3": "subnet-xxxxxxxxxxxxxxxxx",
  "lambdaRole": "arn:aws:iam::YOUR_AWS_ACCOUNT_ID:role/YOUR_LAMBDA_ROLE"
}
```

### 2. `envs.{stage}.json`

Create environment variable files for each deployment stage:

```json
{
  "REDIS_HOST": "your-redis-host.example.com",
  "REDIS_PORT": "6379",
  "RDS_HOST": "your-rds-host.example.com",
  "RDS_PORT": "3306",
  "RDS_DATABASE": "your_database_name",
  "RDS_USER": "your_database_user",
  "RDS_PASSWORD": "${ssm:/path/to/your/rds/password}",
  "LOG_LEVEL": "info"
}
```

**Note:** Use AWS Systems Manager Parameter Store for sensitive values like passwords.

## For Internal Deployment

If you have access to the private `bk-config` repository:
```bash
git submodule update --init --recursive
```

## For External Users

Create your own `bk-config` directory with the files shown above, adapted to your infrastructure.

## Security Notes

- Never commit actual configuration files with real values
- Use AWS Systems Manager Parameter Store for secrets
- Ensure proper IAM permissions are set for accessing these resources
- Rotate credentials regularly
