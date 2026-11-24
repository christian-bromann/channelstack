# The Go reference agent in a Linux image: Go reads SSL_CERT_FILE on Linux (not on macOS), which is
# how proxy mode's CA reaches it (exit check 6.2).
# Base images pinned by digest (the tag in the comment): a rebuild gets the same bytes.
FROM golang:1.26-alpine@sha256:ecb67f987aa1a57794c91d19ade7ae0209f2f0f5496aaef9e6ae85ddf92d02ab AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /agent .

FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
COPY --from=build /agent /agent
ENTRYPOINT ["/agent"]
