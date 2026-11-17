# Domain policy alone allows every port at a resolved address. Apply the
# official operator port floor before per-sandbox rules and Vault injection.
FROM opensandbox/egress:release-1.2.1
RUN mkdir -p /var/egress/rules && printf '80\n443\n' > /var/egress/rules/reachable.ports.cap
