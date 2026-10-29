package app.vybatron.playback

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SharedPlayerTest {
    private fun lines(text: String): List<EventStreamParser.Event> {
        val parser = EventStreamParser()
        return text.split("\n").mapNotNull(parser::line)
    }

    @Test fun readsTheListenerStream() {
        val events = lines("retry: 5000\n\n: connected\n\nevent:player\ndata:{\"a\":1}\n\n: heartbeat\n\nevent: command\ndata: {\"action\":\"pause\"}\n\nevent:rotate\ndata:{}\n\n")
        assertEquals(listOf(EventStreamParser.Event("player", "{\"a\":1}"), EventStreamParser.Event("command", "{\"action\":\"pause\"}"),
            EventStreamParser.Event("rotate", "{}")), events)
    }

    @Test fun joinsDataLinesAndDropsWhatIsTooLarge() {
        assertEquals(listOf(EventStreamParser.Event("message", "one\ntwo")), lines("data:one\ndata:two\n\n"))
        // An event without data is nothing; a field without a colon has an empty value.
        assertEquals(listOf(EventStreamParser.Event("message", "")), lines("event:player\n\ndata\n\n"))
        val parser = EventStreamParser(maxChars = 4)
        assertNull(parser.line("data:12345")); assertNull(parser.line(""))
        parser.line("data:ok"); assertEquals("ok", parser.line("")?.data)
    }

    @Test fun readsThePlayerAndRefusesAMalformedOne() {
        val player = SharedPlayer.parse(Shared.player(generation = 3, active = "me", current = Shared.entry("a"), queue = listOf(Shared.entry("b")), playing = true, at = 1_000, positionMs = 5_000))!!
        assertEquals(3L, player.generation); assertEquals("me", player.activeDeviceId); assertEquals("a".padEnd(12, 'x'), player.current?.entryId)
        assertEquals(listOf("b".padEnd(12, 'x')), player.queue.map { it.entryId })
        // The playhead moves on while it plays, up to the song's end.
        assertEquals(7_000L, player.positionAt(3_000)); assertEquals(240_000L, player.positionAt(10_000_000))
        val native = player.current!!.native()!!
        assertEquals("a".padEnd(12, 'x'), native.entryId); assertEquals(JSONObject.NULL, native.raw.get("requestedBy"))
        assertNull(SharedPlayer.parse(Shared.player().apply { remove("playhead") }))
        assertNull(SharedPlayer.parse(Shared.player().put("current", JSONObject().put("entryId", "short").put("track", song("a").raw))))
    }

    @Test fun readsRelayedCommandsWithTheContractsRanges() {
        assertEquals(RelayedCommand(PlayerRequest.Pause, 4), RelayedCommand.parse("""{"action":"pause","generation":4}"""))
        assertEquals(RelayedCommand(PlayerRequest.Seek(61_000), 1), RelayedCommand.parse("""{"action":"seek","value":61000,"generation":1}"""))
        assertEquals(RelayedCommand(PlayerRequest.Volume(40), 1), RelayedCommand.parse("""{"action":"volume","value":40,"generation":1}"""))
        assertEquals(RelayedCommand(PlayerRequest.SetRepeat(Repeat.QUEUE), 1), RelayedCommand.parse("""{"action":"repeat","value":"queue","generation":1}"""))
        listOf("""{"action":"volume","value":101,"generation":1}""", """{"action":"repeat","value":"all","generation":1}""", """{"action":"stop","generation":1}""",
            """{"action":"play"}""", """{"action":"seek","generation":1}""", "nope")
            .forEach { assertNull(it, RelayedCommand.parse(it)) }
    }

    @Test fun theSessionTheyHandOverIsChecked() {
        val good = """{"csrfToken":"abcDEF_-123","deviceId":"${"d".repeat(22)}","name":"Android app","guildId":"123"}"""
        assertEquals(PlayerRequest.Subscribe(LinkSession("abcDEF_-123", "d".repeat(22), "Android app", "123")),
            PlayerRequest.parse("player.subscribe", JSONObject("""{"session":$good}""")))
        listOf("""{"csrfToken":"a b","deviceId":"${"d".repeat(22)}","name":"x"}""", """{"csrfToken":"a","deviceId":"short","name":"x"}""",
            """{"csrfToken":"a","deviceId":"${"d".repeat(22)}","name":""}""", """{"csrfToken":"a","deviceId":"${"d".repeat(22)}","name":"x","guildId":"../1"}""", "\"text\"")
            .forEach { assertNull(it, PlayerRequest.parse("player.subscribe", JSONObject("""{"session":$it}"""))) }
    }
}
