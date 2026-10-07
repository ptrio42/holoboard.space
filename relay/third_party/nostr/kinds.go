package nostr

import "strconv"

type Kind uint16

func (kind Kind) Num() uint16    { return uint16(kind) }
func (kind Kind) String() string { return "kind::" + kind.Name() + "<" + strconv.Itoa(int(kind)) + ">" }
func (kind Kind) Name() string {
	switch kind {
	case KindProfileMetadata:
		return "ProfileMetadata"
	case KindTextNote:
		return "TextNote"
	case KindRecommendServer:
		return "RecommendServer"
	case KindFollowList:
		return "FollowList"
	case KindEncryptedDirectMessage:
		return "EncryptedDirectMessage"
	case KindDeletion:
		return "Deletion"
	case KindRepost:
		return "Repost"
	case KindReaction:
		return "Reaction"
	case KindBadgeAward:
		return "BadgeAward"
	case KindSimpleGroupChatMessage:
		return "SimpleGroupChatMessage"
	case KindSimpleGroupThreadedReply:
		return "SimpleGroupThreadedReply"
	case KindSimpleGroupThread:
		return "SimpleGroupThread"
	case KindSimpleGroupReply:
		return "SimpleGroupReply"
	case KindSeal:
		return "Seal"
	case KindDirectMessage:
		return "DirectMessage"
	case KindFileMessage:
		return "FileMessage"
	case KindGenericRepost:
		return "GenericRepost"
	case KindReactionToWebsite:
		return "ReactionToWebsite"
	case KindPhoto:
		return "Photo"
	case KindNormalVideoEvent:
		return "NormalVideoEvent"
	case KindShortVideoEvent:
		return "ShortVideoEvent"
	case KindPublicMessage:
		return "PublicMessage"
	case KindChannelCreation:
		return "ChannelCreation"
	case KindChannelMetadata:
		return "ChannelMetadata"
	case KindChannelMessage:
		return "ChannelMessage"
	case KindChannelHideMessage:
		return "ChannelHideMessage"
	case KindChannelMuteUser:
		return "ChannelMuteUser"
	case KindPodcastEpisode:
		return "PodcastEpisode"
	case KindChess:
		return "Chess"
	case KindMergeRequests:
		return "MergeRequests"
	case KindPollResponse:
		return "PollResponse"
	case KindBid:
		return "Bid"
	case KindBidConfirmation:
		return "BidConfirmation"
	case KindOpenTimestamps:
		return "OpenTimestamps"
	case KindGiftWrap:
		return "GiftWrap"
	case KindFileMetadata:
		return "FileMetadata"
	case KindPoll:
		return "Poll"
	case KindComment:
		return "Comment"
	case KindVoiceMessage:
		return "VoiceMessage"
	case KindScroll:
		return "Scroll"
	case KindVoiceMessageComment:
		return "VoiceMessageComment"
	case KindLiveChatMessage:
		return "LiveChatMessage"
	case KindCodeSnippet:
		return "CodeSnippet"
	case KindPatch:
		return "Patch"
	case KindGitPullRequest:
		return "GitPullRequest"
	case KindGitPullRequestUpdate:
		return "GitPullRequestUpdate"
	case KindIssue:
		return "Issue"
	case KindReply:
		return "Reply"
	case KindStatusOpen:
		return "StatusOpen"
	case KindStatusApplied:
		return "StatusApplied"
	case KindStatusClosed:
		return "StatusClosed"
	case KindStatusDraft:
		return "StatusDraft"
	case KindProblemTracker:
		return "ProblemTracker"
	case KindReporting:
		return "Reporting"
	case KindLabel:
		return "Label"
	case KindRelayReviews:
		return "RelayReviews"
	case KindAIEmbeddings:
		return "AIEmbeddings"
	case KindTorrent:
		return "Torrent"
	case KindTorrentComment:
		return "TorrentComment"
	case KindCoinjoinPool:
		return "CoinjoinPool"
	case KindDecoupledKeyClientAnnouncement:
		return "DecoupledKeyClientAnnouncement"
	case KindDecoupledEncryptionKeyDistribution:
		return "DecoupledEncryptionKeyDistribution"
	case KindCommunityPostApproval:
		return "CommunityPostApproval"
	case KindJobFeedback:
		return "JobFeedback"
	case KindReservedCashuWalletTokens:
		return "ReservedCashuWalletTokens"
	case KindCashuWalletTokens:
		return "CashuWalletTokens"
	case KindCashuWalletHistory:
		return "CashuWalletHistory"
	case KindGeocacheLog:
		return "GeocacheLog"
	case KindGeocacheProofOfFind:
		return "GeocacheProofOfFind"
	case KindSimpleGroupPutUser:
		return "SimpleGroupPutUser"
	case KindSimpleGroupRemoveUser:
		return "SimpleGroupRemoveUser"
	case KindSimpleGroupEditMetadata:
		return "SimpleGroupEditMetadata"
	case KindSimpleGroupDeleteEvent:
		return "SimpleGroupDeleteEvent"
	case KindSimpleGroupCreateGroup:
		return "SimpleGroupCreateGroup"
	case KindSimpleGroupDeleteGroup:
		return "SimpleGroupDeleteGroup"
	case KindSimpleGroupCreateInvite:
		return "SimpleGroupCreateInvite"
	case KindSimpleGroupUpdatePinList:
		return "SimpleGroupUpdatePinList"
	case KindSimpleGroupJoinRequest:
		return "SimpleGroupJoinRequest"
	case KindSimpleGroupLeaveRequest:
		return "SimpleGroupLeaveRequest"
	case KindZapGoal:
		return "ZapGoal"
	case KindNutZap:
		return "NutZap"
	case KindTidalLogin:
		return "TidalLogin"
	case KindZapRequest:
		return "ZapRequest"
	case KindZap:
		return "Zap"
	case KindHighlights:
		return "Highlights"
	case KindMuteList:
		return "MuteList"
	case KindPinList:
		return "PinList"
	case KindRelayListMetadata:
		return "RelayListMetadata"
	case KindBookmarkList:
		return "BookmarkList"
	case KindCommunityList:
		return "CommunityList"
	case KindPublicChatList:
		return "PublicChatList"
	case KindBlockedRelayList:
		return "BlockedRelayList"
	case KindSearchRelayList:
		return "SearchRelayList"
	case KindSimpleGroupList:
		return "SimpleGroupList"
	case KindFavoriteRelaysList:
		return "FavoriteRelaysList"
	case KindPrivateEventRelayList:
		return "PrivateEventRelayList"
	case KindInterestList:
		return "InterestList"
	case KindNutZapInfo:
		return "NutZapInfo"
	case KindMediaFollows:
		return "MediaFollows"
	case KindEmojiList:
		return "EmojiList"
	case KindDecoupledKeyAnnouncement:
		return "DecoupledKeyAnnouncement"
	case KindDMRelayList:
		return "DMRelayList"
	case KindFavoritePodcasts:
		return "FavoritePodcasts"
	case KindUserServerList:
		return "UserServerList"
	case KindFileStorageServerList:
		return "FileStorageServerList"
	case KindGoodWikiAuthorList:
		return "GoodWikiAuthorList"
	case KindGoodWikiRelayList:
		return "GoodWikiRelayList"
	case KindPodcastMetadata:
		return "PodcastMetadata"
	case KindAuthoredPodcasts:
		return "AuthoredPodcasts"
	case KindRelayMonitorAnnouncement:
		return "RelayMonitorAnnouncement"
	case KindRoomPresence:
		return "RoomPresence"
	case KindUserGraspList:
		return "UserGraspList"
	case KindProxyAnnouncement:
		return "ProxyAnnouncement"
	case KindTransportMethodAnnouncement:
		return "TransportMethodAnnouncement"
	case KindNWCWalletInfo:
		return "NWCWalletInfo"
	case KindNsiteRoot:
		return "NsiteRoot"
	case KindCashuWalletEvent:
		return "CashuWalletEvent"
	case KindLightningPubRPC:
		return "LightningPubRPC"
	case KindClientAuthentication:
		return "ClientAuthentication"
	case KindNWCWalletRequest:
		return "NWCWalletRequest"
	case KindNWCWalletResponse:
		return "NWCWalletResponse"
	case KindNostrConnect:
		return "NostrConnect"
	case KindBlobs:
		return "Blobs"
	case KindHTTPAuth:
		return "HTTPAuth"
	case KindCategorizedPeopleList:
		return "CategorizedPeopleList"
	case KindCategorizedBookmarksList:
		return "CategorizedBookmarksList"
	case KindRelaySets:
		return "RelaySets"
	case KindBookmarkSets:
		return "BookmarkSets"
	case KindCuratedSets:
		return "CuratedSets"
	case KindCuratedVideoSets:
		return "CuratedVideoSets"
	case KindMuteSets:
		return "MuteSets"
	case KindProfileBadges:
		return "ProfileBadges"
	case KindBadgeDefinition:
		return "BadgeDefinition"
	case KindInterestSets:
		return "InterestSets"
	case KindStallDefinition:
		return "StallDefinition"
	case KindProductDefinition:
		return "ProductDefinition"
	case KindMarketplaceUI:
		return "MarketplaceUI"
	case KindProductSoldAsAuction:
		return "ProductSoldAsAuction"
	case KindArticle:
		return "Article"
	case KindDraftArticle:
		return "DraftArticle"
	case KindEmojiSets:
		return "EmojiSets"
	case KindModularArticleHeader:
		return "ModularArticleHeader"
	case KindModularArticleContent:
		return "ModularArticleContent"
	case KindReleaseArtifactSets:
		return "ReleaseArtifactSets"
	case KindApplicationSpecificData:
		return "ApplicationSpecificData"
	case KindRelayDiscovery:
		return "RelayDiscovery"
	case KindAppCurationSet:
		return "AppCurationSet"
	case KindLiveEvent:
		return "LiveEvent"
	case KindInteractiveRoom:
		return "InteractiveRoom"
	case KindConferenceEvent:
		return "ConferenceEvent"
	case KindUserStatuses:
		return "UserStatuses"
	case KindSlideSet:
		return "SlideSet"
	case KindClassifiedListing:
		return "ClassifiedListing"
	case KindDraftClassifiedListing:
		return "DraftClassifiedListing"
	case KindRepositoryAnnouncement:
		return "RepositoryAnnouncement"
	case KindRepositoryState:
		return "RepositoryState"
	case KindWikiArticle:
		return "WikiArticle"
	case KindRedirects:
		return "Redirects"
	case KindDraftEvent:
		return "DraftEvent"
	case KindLinkSet:
		return "LinkSet"
	case KindFeed:
		return "Feed"
	case KindDateCalendarEvent:
		return "DateCalendarEvent"
	case KindTimeCalendarEvent:
		return "TimeCalendarEvent"
	case KindCalendar:
		return "Calendar"
	case KindCalendarEventRSVP:
		return "CalendarEventRSVP"
	case KindHandlerRecommendation:
		return "HandlerRecommendation"
	case KindHandlerInformation:
		return "HandlerInformation"
	case KindSoftwareApplication:
		return "SoftwareApplication"
	case KindLegacyNsiteFile:
		return "LegacyNsiteFile"
	case KindVideoViewEvent:
		return "VideoViewEvent"
	case KindCommunityDefinition:
		return "CommunityDefinition"
	case KindNsiteNamed:
		return "NsiteNamed"
	case KindGeocacheListing:
		return "GeocacheListing"
	case KindGeocacheLogEntry:
		return "GeocacheLogEntry"
	case KindCashuMintAnnouncement:
		return "CashuMintAnnouncement"
	case KindFedimintAnnouncement:
		return "FedimintAnnouncement"
	case KindPeerToPeerOrderEvents:
		return "PeerToPeerOrderEvents"
	case KindSimpleGroupMetadata:
		return "SimpleGroupMetadata"
	case KindSimpleGroupAdmins:
		return "SimpleGroupAdmins"
	case KindSimpleGroupMembers:
		return "SimpleGroupMembers"
	case KindSimpleGroupRoles:
		return "SimpleGroupRoles"
	case KindSimpleGroupLiveKitParticipants:
		return "SimpleGroupLiveKitParticipants"
	case KindSimpleGroupPinnedEvents:
		return "SimpleGroupPinnedEvents"
	case KindStarterPacks:
		return "StarterPacks"
	case KindMediaStarterPacks:
		return "MediaStarterPacks"
	case KindWebBookmarks:
		return "WebBookmarks"

	}
	return "unknown"
}

const (
	KindProfileMetadata                    Kind = 0
	KindTextNote                           Kind = 1
	KindRecommendServer                    Kind = 2
	KindFollowList                         Kind = 3
	KindEncryptedDirectMessage             Kind = 4
	KindDeletion                           Kind = 5
	KindRepost                             Kind = 6
	KindReaction                           Kind = 7
	KindBadgeAward                         Kind = 8
	KindSimpleGroupChatMessage             Kind = 9
	KindSimpleGroupThreadedReply           Kind = 10
	KindSimpleGroupThread                  Kind = 11
	KindSimpleGroupReply                   Kind = 12
	KindSeal                               Kind = 13
	KindDirectMessage                      Kind = 14
	KindFileMessage                        Kind = 15
	KindGenericRepost                      Kind = 16
	KindReactionToWebsite                  Kind = 17
	KindPhoto                              Kind = 20
	KindNormalVideoEvent                   Kind = 21
	KindShortVideoEvent                    Kind = 22
	KindPublicMessage                      Kind = 24
	KindChannelCreation                    Kind = 40
	KindChannelMetadata                    Kind = 41
	KindChannelMessage                     Kind = 42
	KindChannelHideMessage                 Kind = 43
	KindChannelMuteUser                    Kind = 44
	KindPodcastEpisode                     Kind = 54
	KindChess                              Kind = 64
	KindMergeRequests                      Kind = 818
	KindPollResponse                       Kind = 1018
	KindBid                                Kind = 1021
	KindBidConfirmation                    Kind = 1022
	KindOpenTimestamps                     Kind = 1040
	KindGiftWrap                           Kind = 1059
	KindFileMetadata                       Kind = 1063
	KindPoll                               Kind = 1068
	KindComment                            Kind = 1111
	KindVoiceMessage                       Kind = 1222
	KindScroll                             Kind = 1227
	KindVoiceMessageComment                Kind = 1244
	KindLiveChatMessage                    Kind = 1311
	KindCodeSnippet                        Kind = 1337
	KindPatch                              Kind = 1617
	KindGitPullRequest                     Kind = 1618
	KindGitPullRequestUpdate               Kind = 1619
	KindIssue                              Kind = 1621
	KindReply                              Kind = 1622
	KindStatusOpen                         Kind = 1630
	KindStatusApplied                      Kind = 1631
	KindStatusClosed                       Kind = 1632
	KindStatusDraft                        Kind = 1633
	KindProblemTracker                     Kind = 1971
	KindReporting                          Kind = 1984
	KindLabel                              Kind = 1985
	KindRelayReviews                       Kind = 1986
	KindAIEmbeddings                       Kind = 1987
	KindTorrent                            Kind = 2003
	KindTorrentComment                     Kind = 2004
	KindCoinjoinPool                       Kind = 2022
	KindDecoupledKeyClientAnnouncement     Kind = 4454
	KindDecoupledEncryptionKeyDistribution Kind = 4455
	KindCommunityPostApproval              Kind = 4550
	KindJobFeedback                        Kind = 7000
	KindReservedCashuWalletTokens          Kind = 7374
	KindCashuWalletTokens                  Kind = 7375
	KindCashuWalletHistory                 Kind = 7376
	KindGeocacheLog                        Kind = 7516
	KindGeocacheProofOfFind                Kind = 7517
	KindSimpleGroupPutUser                 Kind = 9000
	KindSimpleGroupRemoveUser              Kind = 9001
	KindSimpleGroupEditMetadata            Kind = 9002
	KindSimpleGroupDeleteEvent             Kind = 9005
	KindSimpleGroupCreateGroup             Kind = 9007
	KindSimpleGroupDeleteGroup             Kind = 9008
	KindSimpleGroupCreateInvite            Kind = 9009
	KindSimpleGroupUpdatePinList           Kind = 9010
	KindSimpleGroupJoinRequest             Kind = 9021
	KindSimpleGroupLeaveRequest            Kind = 9022
	KindZapGoal                            Kind = 9041
	KindNutZap                             Kind = 9321
	KindTidalLogin                         Kind = 9467
	KindZapRequest                         Kind = 9734
	KindZap                                Kind = 9735
	KindHighlights                         Kind = 9802
	KindMuteList                           Kind = 10000
	KindPinList                            Kind = 10001
	KindRelayListMetadata                  Kind = 10002
	KindBookmarkList                       Kind = 10003
	KindCommunityList                      Kind = 10004
	KindPublicChatList                     Kind = 10005
	KindBlockedRelayList                   Kind = 10006
	KindSearchRelayList                    Kind = 10007
	KindSimpleGroupList                    Kind = 10009
	KindFavoriteRelaysList                 Kind = 10012
	KindPrivateEventRelayList              Kind = 10013
	KindInterestList                       Kind = 10015
	KindNutZapInfo                         Kind = 10019
	KindMediaFollows                       Kind = 10020
	KindEmojiList                          Kind = 10030
	KindDecoupledKeyAnnouncement           Kind = 10044
	KindDMRelayList                        Kind = 10050
	KindFavoritePodcasts                   Kind = 10054
	KindUserServerList                     Kind = 10063
	KindFileStorageServerList              Kind = 10096
	KindGoodWikiAuthorList                 Kind = 10101
	KindGoodWikiRelayList                  Kind = 10102
	KindPodcastMetadata                    Kind = 10154
	KindAuthoredPodcasts                   Kind = 10164
	KindRelayMonitorAnnouncement           Kind = 10166
	KindRoomPresence                       Kind = 10312
	KindUserGraspList                      Kind = 10317
	KindProxyAnnouncement                  Kind = 10377
	KindTransportMethodAnnouncement        Kind = 11111
	KindNWCWalletInfo                      Kind = 13194
	KindNsiteRoot                          Kind = 15128
	KindCashuWalletEvent                   Kind = 17375
	KindLightningPubRPC                    Kind = 21000
	KindClientAuthentication               Kind = 22242
	KindNWCWalletRequest                   Kind = 23194
	KindNWCWalletResponse                  Kind = 23195
	KindNostrConnect                       Kind = 24133
	KindBlobs                              Kind = 24242
	KindHTTPAuth                           Kind = 27235
	KindCategorizedPeopleList              Kind = 30000
	KindCategorizedBookmarksList           Kind = 30001
	KindRelaySets                          Kind = 30002
	KindBookmarkSets                       Kind = 30003
	KindCuratedSets                        Kind = 30004
	KindCuratedVideoSets                   Kind = 30005
	KindMuteSets                           Kind = 30007
	KindProfileBadges                      Kind = 30008
	KindBadgeDefinition                    Kind = 30009
	KindInterestSets                       Kind = 30015
	KindStallDefinition                    Kind = 30017
	KindProductDefinition                  Kind = 30018
	KindMarketplaceUI                      Kind = 30019
	KindProductSoldAsAuction               Kind = 30020
	KindArticle                            Kind = 30023
	KindDraftArticle                       Kind = 30024
	KindEmojiSets                          Kind = 30030
	KindModularArticleHeader               Kind = 30040
	KindModularArticleContent              Kind = 30041
	KindReleaseArtifactSets                Kind = 30063
	KindApplicationSpecificData            Kind = 30078
	KindRelayDiscovery                     Kind = 30166
	KindAppCurationSet                     Kind = 30267
	KindLiveEvent                          Kind = 30311
	KindInteractiveRoom                    Kind = 30312
	KindConferenceEvent                    Kind = 30313
	KindUserStatuses                       Kind = 30315
	KindSlideSet                           Kind = 30388
	KindClassifiedListing                  Kind = 30402
	KindDraftClassifiedListing             Kind = 30403
	KindRepositoryAnnouncement             Kind = 30617
	KindRepositoryState                    Kind = 30618
	KindWikiArticle                        Kind = 30818
	KindRedirects                          Kind = 30819
	KindDraftEvent                         Kind = 31234
	KindLinkSet                            Kind = 31388
	KindFeed                               Kind = 31890
	KindDateCalendarEvent                  Kind = 31922
	KindTimeCalendarEvent                  Kind = 31923
	KindCalendar                           Kind = 31924
	KindCalendarEventRSVP                  Kind = 31925
	KindHandlerRecommendation              Kind = 31989
	KindHandlerInformation                 Kind = 31990
	KindSoftwareApplication                Kind = 32267
	KindLegacyNsiteFile                    Kind = 34128
	KindVideoViewEvent                     Kind = 34237
	KindCommunityDefinition                Kind = 34550
	KindNsiteNamed                         Kind = 35128
	KindGeocacheListing                    Kind = 37515
	KindGeocacheLogEntry                   Kind = 37516
	KindCashuMintAnnouncement              Kind = 38172
	KindFedimintAnnouncement               Kind = 38173
	KindPeerToPeerOrderEvents              Kind = 38383
	KindSimpleGroupMetadata                Kind = 39000
	KindSimpleGroupAdmins                  Kind = 39001
	KindSimpleGroupMembers                 Kind = 39002
	KindSimpleGroupRoles                   Kind = 39003
	KindSimpleGroupLiveKitParticipants     Kind = 39004
	KindSimpleGroupPinnedEvents            Kind = 39005
	KindStarterPacks                       Kind = 39089
	KindMediaStarterPacks                  Kind = 39092
	KindWebBookmarks                       Kind = 39701
)

func (kind Kind) IsRegular() bool {
	return kind < 10000 && kind != 0 && kind != 3
}

func (kind Kind) IsReplaceable() bool {
	return kind == 0 || kind == 3 || (10000 <= kind && kind < 20000)
}

func (kind Kind) IsEphemeral() bool {
	return 20000 <= kind && kind < 30000
}

func (kind Kind) IsAddressable() bool {
	return 30000 <= kind && kind < 40000
}
