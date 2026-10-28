package app.vybatron

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PortalOriginTest {
    @Test fun acceptsBareHttpsOrigins() {
        assertEquals("https://portal.example", PortalOrigin.parse("https://portal.example")?.value)
        assertEquals("https://portal.example:8443", PortalOrigin.parse("https://Portal.Example:8443")?.value)
        assertEquals("https://portal.example", PortalOrigin.parse("https://portal.example:443")?.value)
    }

    @Test fun refusesAnythingButABareHttpsOrigin() {
        listOf("", "portal.example", "http://portal.example", "https://portal.example/", "https://portal.example/app",
            "https://portal.example?x=1", "https://portal.example#x", "https://user@portal.example", "javascript:alert(1)")
            .forEach { assertNull(it, PortalOrigin.parse(it)) }
    }

    @Test fun matchesOnlyTheSameOrigin() {
        val portal = PortalOrigin.parse("https://portal.example")!!
        assertTrue(portal.matches("https://portal.example/api/x?y=1"))
        assertTrue(portal.matches("https://PORTAL.example:443/"))
        assertFalse(portal.matches("http://portal.example/"))
        assertFalse(portal.matches("https://portal.example:8443/"))
        assertFalse(portal.matches("https://evil.portal.example/"))
        assertFalse(portal.matches("https://portal.example.evil.test/"))
        assertFalse(portal.matches("null"))
    }
}
