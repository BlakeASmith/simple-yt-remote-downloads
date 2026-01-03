#!/bin/bash

# Start cron daemon
service cron start

# Run the server
exec "$@"
