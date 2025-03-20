FROM bitnami/postgresql:17.4.0-debian-12-r8

USER root

RUN install_packages git build-essential
RUN cd /tmp && \
    git clone --branch v0.8.0 https://github.com/pgvector/pgvector.git && \
    cd pgvector && \
    export PG_CONFIG=/opt/bitnami/postgresql/bin/pg_config && \
    make && \
    make install

USER 1001
