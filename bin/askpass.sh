#!/bin/sh
# Used by ssh (SSH_ASKPASS) to hand over a device's password without putting it on a command line.
printf '%s\n' "$LC_SSH_PASS"
