#!/bin/bash

find $PWD/temp/logs -type f -name xud*.log -printf "\n%f\n\n" -exec cat {} \;
