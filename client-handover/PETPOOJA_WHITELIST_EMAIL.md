# PETPOOJA SANDBOX IP WHITELIST EMAIL

**To:** `support@petpooja.com`  
**Subject:** `Update Whitelisted IP for Sandbox Testing — Mapping Code: 31z58ciw0h (Burgonomics)`

---

```text
Hi Petpooja Support Team,

We are currently testing our integration in the Petpooja Sandbox environment for:
• Account Email: burgonomicsind@gmail.com
• Mapping Code (restID): 31z58ciw0h

Our previously whitelisted IP was 103.250.137.67.

Our local ISP has dynamically renewed our IP address, and we are currently unable to access the developer sandbox portal (https://developerapi.petpooja.com/) due to a 403 Forbidden firewall error.

Please update our whitelisted IP to our current active IPs and subnets so we can log in, access our sandbox tokens in the Configuration tab, and complete our sandbox testing:

CURRENT ACTIVE PUBLIC IPs:
• Primary (GTPL Broadband): 43.242.116.109
• Secondary (Reliance Jio): 152.58.34.68

SUBNETS TO WHITELIST (to prevent lockouts on ISP DHCP renewal):
• 43.242.116.0/24   (GTPL Broadband Ahmedabad)
• 103.250.137.0/24  (GTPL Broadband Ahmedabad - our previous pool)
• 103.249.233.0/24  (GTPL Broadband Ahmedabad)
• 43.250.158.0/24   (GTPL Broadband Ahmedabad)
• 152.58.34.0/23    (Reliance Jio Mobile)

SANDBOX WEBHOOK URL:
https://api-jgxunirgwq-el.a.run.app/petpooja/webhook

Please confirm once the IP is updated on your firewall so we can log into https://developerapi.petpooja.com/ and execute our test orders.

Thank you,
Jesal Pande
Burgonomics
burgonomicsind@gmail.com
```
