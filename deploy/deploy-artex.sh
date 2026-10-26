#!/bin/sh
# 群晖端手动部署脚本（git pull 模式用）
cd /volume1/docker/artex && git pull && docker compose up -d --build artex
