# The Go reference agent in a Linux image: Go reads SSL_CERT_FILE on Linux (not on macOS), which is
# how proxy mode's CA reaches it (exit check 6.2).
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /agent .

FROM alpine:3.22
COPY --from=build /agent /agent
ENTRYPOINT ["/agent"]
