# Disposable SSH host for ladvin e2e tests. Build context is prepared by e2e.test.ts.
FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server tmux ca-certificates \
 && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd \
 && useradd -m -s /bin/bash dev && passwd -d dev
COPY authorized_keys /home/dev/.ssh/authorized_keys
# `claude` is only on the *login* PATH (via .profile), like a typical ~/.local/bin install.
COPY claude /home/dev/.local/bin/claude
RUN echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/dev/.profile \
 && chmod 755 /home/dev/.local/bin/claude && chmod 700 /home/dev/.ssh && chmod 600 /home/dev/.ssh/authorized_keys \
 && chown -R dev:dev /home/dev
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
