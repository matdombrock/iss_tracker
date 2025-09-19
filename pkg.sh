#!/bin/bash

set -e
rm -f iss_tracker.zip
cd public
zip -r ../iss_tracker.zip .
