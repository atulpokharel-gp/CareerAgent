# Infra notes

This directory contains baseline deployment manifests for high-traffic API scaling.

- k8s-server.yaml: Deployment, HPA, Service
- server/Dockerfile: container image for API

## Important scaling follow-up

Session and event fanout are Redis-backed. Next scaling step is adding distributed work queues for scan/apply workers and Redis-backed distributed rate limits.
