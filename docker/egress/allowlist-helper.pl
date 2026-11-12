#!/usr/bin/perl
# Squid external ACL helper: OK when the destination host is in the per-attempt
# allowlist file, ERR otherwise. An empty or missing file allows nothing.
use strict;
use warnings;
$| = 1;
my $file = "/etc/squid/allow/allowlist.txt";
while (my $line = <STDIN>) {
  chomp $line;
  my $host = lc((split /\s+/, $line)[0] // "");
  $host =~ s/:\d+$//;
  my $ok = 0;
  if ($host ne "" && open(my $fh, "<", $file)) {
    while (my $allowed = <$fh>) {
      $allowed =~ s/^\s+|\s+$//g;
      next if $allowed eq "" || $allowed =~ /^#/;
      if (lc($allowed) eq $host) { $ok = 1; last; }
    }
    close($fh);
  }
  print $ok ? "OK\n" : "ERR\n";
}
