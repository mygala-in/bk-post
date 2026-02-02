# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please follow these steps:

### Reporting Process

1. **DO NOT** open a public GitHub issue
2. Email security details to: (add your security contact email)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### What to Expect

- **Initial Response**: Within 48 hours
- **Status Update**: Within 7 days
- **Fix Timeline**: Depends on severity
  - Critical: 1-3 days
  - High: 1-2 weeks
  - Medium: 2-4 weeks
  - Low: Next release cycle

### Disclosure Policy

- We will acknowledge your report within 48 hours
- We will provide regular updates on our progress
- We will notify you when the vulnerability is fixed
- We will credit you in the fix (unless you prefer to remain anonymous)

## Security Best Practices

### For Deployments

1. **Environment Variables**
   - Never commit `.env` files or configuration with secrets
   - Use AWS Systems Manager Parameter Store for sensitive data
   - Rotate credentials regularly

2. **IAM Permissions**
   - Follow principle of least privilege
   - Use separate roles for different environments
   - Regularly audit IAM permissions

3. **Database Security**
   - Deploy Lambda functions in VPC for database access
   - Use security groups to restrict access
   - Enable encryption at rest and in transit
   - Use strong passwords stored in AWS Secrets Manager

4. **API Security**
   - Validate all input
   - Implement rate limiting
   - Use CORS appropriately
   - Validate JWT tokens properly

5. **Dependency Management**
   - Regularly update dependencies
   - Run `npm audit` before deployments
   - Monitor security advisories

### For Development

1. **Code Review**
   - All code changes require review
   - Look for security issues during review
   - Use linting tools

2. **Secrets Management**
   - Never hardcode credentials
   - Don't log sensitive information
   - Clean up test data containing PII

3. **Testing**
   - Test authentication and authorization
   - Test input validation
   - Test error handling

## Known Security Considerations

### Authentication
- This service relies on JWT token validation implemented in `bk-utils/access`
- Ensure tokens are validated on every request
- Tokens should have appropriate expiration times

### Authorization
- Occasion membership is verified before allowing post operations
- Users can only modify their own posts, likes, and comments
- Implement additional authorization checks as needed

### Data Privacy
- User data should be handled according to privacy policies
- Implement data retention policies
- Consider GDPR/privacy requirements for your jurisdiction

### Infrastructure
- Lambda functions should run in VPC when accessing databases
- Use security groups to control network access
- Enable CloudWatch logs for audit trails
- Consider enabling AWS WAF for API Gateway

## Dependency Security

Current dependencies are regularly monitored for vulnerabilities:
- Run `npm audit` to check for known vulnerabilities
- Update dependencies when security patches are available
- Review dependency changes in PRs

## Security Updates

Security updates will be released as needed:
- Critical vulnerabilities: Immediate patch release
- High severity: Patch release within 1 week
- Medium/Low: Included in next regular release

Subscribe to repository notifications to stay informed about security updates.

## Third-Party Services

This service integrates with:
- **AWS Services**: Lambda, API Gateway, SNS, Systems Manager
- **Redis**: For caching
- **MySQL/RDS**: For data persistence
- **FCM**: For push notifications

Ensure all third-party services are properly secured and configured.

## Compliance

- Follow OWASP Top 10 guidelines
- Implement secure coding practices
- Regular security assessments recommended
- Consider penetration testing for production deployments

## Questions?

For security-related questions that are not vulnerabilities, feel free to open a GitHub issue or discussion.
