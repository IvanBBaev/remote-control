import XCTest

/// M4-04: approve a pending PermissionRequest from the session screen with Face ID.
/// Run with a paired agent holding one request. While the test waits on Face ID, send
/// `xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit_Sim.pearl.match`.
final class AllowFaceIDUITests: XCTestCase {
  private let app = XCUIApplication(bundleIdentifier: "dev.ivanbaev.remotecontrol")
  private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

  private func shot(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testAllowWithFaceID() throws {
    app.activate()
    let alertAllow = springboard.alerts.buttons["Allow"]
    if alertAllow.waitForExistence(timeout: 3) { alertAllow.tap() }
    // Close the Expo dev menu sheet if it is up (its X button, top right of the sheet).
    if app.staticTexts["Reload"].waitForExistence(timeout: 3) {
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.898, dy: 0.4875)).tap()
      sleep(2)
    }
    XCTAssertTrue(app.staticTexts["1 needs you"].waitForExistence(timeout: 15))
    shot("m4-04-agents")
    // The waiting row (a Pressable groups its texts into one element).
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.22)).tap()

    let allow = app.buttons["Allow"].firstMatch
    XCTAssertTrue(allow.waitForExistence(timeout: 15))
    shot("m4-04-session")
    allow.tap()
    sleep(2)
    shot("m4-04-faceid")
    // Face ID match is sent from the host; wait for the card to leave the screen.
    let gone = NSPredicate(format: "exists == false")
    expectation(for: gone, evaluatedWith: allow)
    waitForExpectations(timeout: 60)
    sleep(2)
    shot("m4-04-decided")
  }
}
