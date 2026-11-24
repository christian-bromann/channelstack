// A Slack agent in Go, the way a Go team writes one with slack-go: it receives the Events API over
// HTTP and answers DMs and mentions. It has no channelstack code and no API URL: slack-go calls
// slack.com, and in proxy mode HTTPS_PROXY and SSL_CERT_FILE send that to the fake (exit check 6.2).
package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/slack-go/slack"
	"github.com/slack-go/slack/slackevents"
)

func main() {
	token, secret, port := os.Getenv("SLACK_BOT_TOKEN"), os.Getenv("SLACK_SIGNING_SECRET"), os.Getenv("PORT")
	if token == "" || secret == "" || port == "" {
		log.Fatal("The agent needs SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET and PORT")
	}
	api := slack.New(token)
	self, err := api.AuthTest()
	if err != nil {
		log.Fatalf("auth.test: %v", err)
	}

	http.HandleFunc("/slack/events", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		verifier, err := slack.NewSecretsVerifier(r.Header, secret)
		if err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if _, err := verifier.Write(body); err != nil || verifier.Ensure() != nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		event, err := slackevents.ParseEvent(json.RawMessage(body), slackevents.OptionNoVerifyToken())
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		switch event.Type {
		case slackevents.URLVerification:
			var challenge slackevents.ChallengeResponse
			if err := json.Unmarshal(body, &challenge); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte(challenge.Challenge))
			return
		case slackevents.CallbackEvent:
			// Acknowledge at once, and answer after: Slack retries what isn't acknowledged in 3 seconds.
			w.WriteHeader(http.StatusOK)
			go answer(api, self.UserID, event.InnerEvent)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	log.Printf("go-slack agent listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

// answer replies to a DM in the DM, and to a mention in its thread. It never answers a bot, itself included.
func answer(api *slack.Client, self string, inner slackevents.EventsAPIInnerEvent) {
	var channel, thread, text string
	switch event := inner.Data.(type) {
	case *slackevents.MessageEvent:
		if event.ChannelType != "im" || event.BotID != "" || event.User == self || event.SubType != "" {
			return
		}
		channel, text = event.Channel, event.Text
	case *slackevents.AppMentionEvent:
		if event.BotID != "" {
			return
		}
		channel, text, thread = event.Channel, event.Text, event.TimeStamp
		if event.ThreadTimeStamp != "" {
			thread = event.ThreadTimeStamp
		}
	default:
		return
	}
	options := []slack.MsgOption{slack.MsgOptionText(reply(text), false)}
	if thread != "" {
		options = append(options, slack.MsgOptionTS(thread))
	}
	if _, _, err := api.PostMessage(channel, options...); err != nil {
		log.Printf("chat.postMessage: %v", err)
	}
}

func reply(text string) string {
	if strings.Contains(strings.ToLower(text), "plate") {
		return "Here's what's on your plate today: the incident review at 10, then the release checklist."
	}
	return "On it."
}
